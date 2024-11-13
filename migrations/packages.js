import fs from 'fs';
import {logger, setVerbosity} from '../logger.js';
import {execSync, exec} from 'child_process';

import { ProxyAgent, fetch as undiciFetch } from "undici";
import dotenv from "dotenv";
import {Octokit} from "@octokit/rest";

dotenv.config();

const SOURCE_TOKEN = process.env.SOURCE_TOKEN;
const TARGET_TOKEN = process.env.TARGET_TOKEN;

// Create a ProxyAgent instance with your proxy settings
const proxyAgent = new ProxyAgent({
  uri: process.env.HTTPS_PROXY,  // URL of the proxy server
  keepAliveTimeout: 10,          // Optional, set keep-alive timeout
  keepAliveMaxTimeout: 10        // Optional, set max keep-alive timeout
});

// Define a custom fetch function that uses the ProxyAgent
const myFetch = (url, options = {}) => {
  return undiciFetch(url, {
    ...options,
    dispatcher: proxyAgent,  // Attach the ProxyAgent to the dispatcher option
  });
};


export async function migratePackages(sourceOctokit, targetOctokit, sourceGraphQL, targetGraphQL, sourceOrg, targetOrg, packageType, dryRun, verbose, page, startIndex, endIndex, packageInputFile, versionIndex) {
  setVerbosity(verbose);
  // logger.info(`Starting package migration process... (Dry Run: ${dryRun})`);
  console.log("[Start Index]: " + startIndex)
  console.log("[End Index]: " + endIndex)
  console.log("[Version Index]: " + versionIndex)
  console.log("[Package Input File]: " + packageInputFile)
  try {
    const packages = await fetchPackages(sourceOctokit, sourceOrg, packageType, page, packageInputFile);
    var useSkipFile = false
    if (packageInputFile.length === 0) {
      useSkipFile = true
    }
    useSkipFile = true
    console.log("[Skip File Active]: " + useSkipFile)
    await processPackages(sourceOctokit, targetOctokit, sourceGraphQL, targetGraphQL, sourceOrg, targetOrg, packages, dryRun, startIndex, endIndex, useSkipFile, versionIndex);
  } catch (error) {
    logger.error('Error migrating packages:', error);
  }
}

async function fetchPackages(sourceOctokit, sourceOrg, packageType, page, input_file_name) {
  console.log("Fetching packages...")
  if (input_file_name.length === 0) {
    console.log(" - Pulling from API...")
      const { data: packages } = await sourceOctokit.packages.listPackagesForOrganization({
        package_type: packageType,
        org: sourceOrg,
        per_page:100,
        page: Number(page)
      });

    console.log(`Found ${packages.length} packages in organization: ${sourceOrg}`);
    return packages;
  }
  else {
    console.log(" - Pulling from local list...")
    let manualPackages = loadPackages(input_file_name)

    return manualPackages
  }

}


async function processPackages(sourceOctokit, targetOctokit, sourceGraphQL, targetGraphQL, sourceOrg, targetOrg, packages, dryRun, startIndex, endIndex, useSkipFile, versionIndex) {
  var counter = 1
  var package_start_index = Number(startIndex)
  var package_end_index = Number(endIndex)

  let packageSkipList = loadPackages("skip_packages_list.txt")
  for (const pkg of packages) {
    console.log(`(${counter}/${packages.length}) Processing package: ${pkg.name} (${pkg.package_type})`);
    if (useSkipFile) {
      for (const skipPkg of packageSkipList) {
        console.log("> " + skipPkg.name)
        if (pkg.name === skipPkg.name) {
          console.log("MATCH")
        }
      }
    }
    if (counter<package_start_index) {
      console.log(`\t - Skipping until reached started ${package_start_index}`)
      counter++
      continue
    }

    if (counter>package_end_index) {
      console.log("End reached...")
      break
    }

    try {
      await processPackage(sourceOctokit, targetOctokit, sourceGraphQL, targetGraphQL, sourceOrg, targetOrg, pkg, dryRun, versionIndex);
    } catch (error) {
      logger.error(`Error processing package ${pkg.name}:`, error);
      break
    }
    counter++
    versionIndex = 1
    console.log("> Resetting version index")
    console.log("****************************************************************************************************************************************************************************************************************************************************************************")
    // break
  }
}

async function loadPackages(fileName) {
  const manual_packages = [];

  try {
    const data = await fs.promises.readFile(`priority_packs/${fileName}`, 'utf8');
    const lines = data.split('\n');

    for (let i = 0; i < lines.length; i++) {
      manual_packages.push({
        name: lines[i],
        package_type: "maven"
      });
    }

    return manual_packages;
  } catch (err) {
    console.error('Error occurred:', err);  // Debug point 6
    throw err;
  }
}
async function processPackage(sourceOctokit, targetOctokit, sourceGraphQL, targetGraphQL, sourceOrg, targetOrg, pkg, dryRun, versionIndex) {
  const versions = await fetchPackageVersions(sourceOctokit, sourceOrg, pkg);

  if (dryRun) {
    logger.info(`[Dry Run] Would migrate package: ${pkg.name} from ${sourceOrg} to ${targetOrg}`);
    logger.info(`[Dry Run] Versions to migrate: ${versions.map(v => v.name).join(', ')}`);
  } else {
    await migratePackageVersions(sourceOctokit, targetOctokit, sourceGraphQL, targetGraphQL, sourceOrg, targetOrg, pkg, versions, dryRun, versionIndex);
  }
}

async function fetchPackageVersions(sourceOctokit, sourceOrg, pkg) {
  console.log(`\t> Fetching versions of package: ${pkg.name} ${pkg.package_type}` )
  // logger.info(`Fetching versions of package: ${pkg.name} (${pkg.package_type})`);
  var page_index = 1
  var versionsE2E = []
  while (true) {
      const { data: versions } = await sourceOctokit.packages.getAllPackageVersionsForPackageOwnedByOrg({
        package_type: pkg.package_type,
        package_name: pkg.name,
        org: sourceOrg,
        per_page:100,
        page: page_index
      });
      console.log(`\t\t- Found ${versions.length} versions of the package ${pkg.name}`);

    if (versions.length === 0) {
      console.log("\t\t- Total Versions: " + versionsE2E.length)
      return versionsE2E
    }
    else {
      versionsE2E = versionsE2E.concat(versions)
      page_index++
    }
  }

  return versionsE2E;
}


async function migratePackageVersions(sourceOctokit, targetOctokit, sourceGraphQL, targetGraphQL, sourceOrg, targetOrg, pkg, versions, dryRun, versionIndex) {
  console.log("\t> Starting Package Verion Migration")
  var counter = 1
  var total = versions.length
  for (const version of versions.reverse()) {
    console.log(`\t\t> (${counter}/${total}) Migrating version ${version.name} of package ${pkg.name}`);

    if (counter < Number(versionIndex)) {
      console.log("\t\t\t- Skipping until version index hit....")
      counter+=1
      continue
    }
    try {
      await migratePackageVersion(sourceOctokit, sourceGraphQL, targetGraphQL, sourceOrg, targetOrg, pkg, version, dryRun);
    } catch (versionError) {
      throw versionError
    }
    counter+=1
    console.log('> Moving to next version...\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
  }
}

async function migratePackageVersion(sourceOctokit, sourceGraphQL, targetGraphQL, sourceOrg, targetOrg, pkg, version, dryRun) {
  // console.log(`\t\t> Migrating version ${version.name} of package ${pkg.name}`);

  try {
    const packageContent = await getPackageContent(sourceOctokit, sourceOrg, pkg, version.name);
    console.log('\t\t\t- Package content retrieved successfully');

    const { downloadBaseUrl, downloadPackageUrl, uploadPackageUrl } = getPackageUrls(pkg, packageContent, sourceOrg, targetOrg, version.name);
    // console.log("\t\t\t> Download URL: " + downloadPackageUrl)

    let filesToDownload = [];
    switch (pkg.package_type) {
      case 'maven':
      case 'gradle':
        filesToDownload = await listMavenPackageAssets(pkg.package_type, pkg.name, sourceGraphQL, targetGraphQL, sourceOrg, version.name);
        break;
      default:
        logger.warn(`Unsupported package type: ${pkg.package_type}`);
        return;
    }

    if (!filesToDownload.length) {
      logger.warn(`No files found for package ${pkg.name} version ${version.name}`);
      return;
    }
    // for (const file of filesToDownload) {
    //   console.log(`\t\t\t\t- ${file}`)
    // }
    // console.log(`\t\t\t- Files to download: ${filesToDownload.join(', ')}`);

    if (dryRun) {
      logger.info(`[Dry Run] Would download ${filesToDownload.length} files for ${pkg.name} version ${version.name}`);
      logger.info(`[Dry Run] Would upload ${filesToDownload.length} files to ${uploadPackageUrl}`);
    } else {
      switch (pkg.package_type) {
        case 'maven':
        case 'gradle':
          //check if cache exists
          if (fs.existsSync(`packages/${pkg.name}/${version.name}`)) {
            console.log("\t\t- Cache HIT [packages/" + pkg.name + "/" + version.name + "]" )
            await uploadMavenFilesParallel(uploadPackageUrl, pkg.name, version.name, filesToDownload);
          }
          else {
            console.log("\t\t- Cache MISS [packages/" + pkg.name + "/" + version.name + "]" )
            await downloadMavenFilesParallel(downloadPackageUrl, pkg.name, version.name, filesToDownload);
            await uploadMavenFilesParallel(uploadPackageUrl, pkg.name, version.name,filesToDownload);
          }
          break;
      }
    }

    console.log(`${dryRun ? '[Dry Run] Would migrate' : 'Migrated'} version ${version.name} of ${pkg.name}`);
  } catch (error) {
    console.log(`> Error migrating version ${version.name} of ${pkg.name}: ${error.message}`);
    console.log(error)
    if (error.stack) {
      logger.debug(`Stack trace: ${error.stack}`);
    }
    throw error; // Re-throw to be handled by the caller
  }
}

async function downloadMavenFilesParallel(downloadPackageUrl, packageName, version, filesToDownload) {
  const concurrency = parseInt(process.env.MAVEN_CONCURRENCY || '4');
  if (fs.existsSync(`packages/${packageName}/${version}`)) {
    console.log("PATH ALREADY CACHED")
    console.log("\t- packages/"+packageName+"/"+version)
    return
  }
  fs.mkdirSync(`packages/${packageName}/${version}`, { recursive: true });
  const chunks = [];

  // Split files into chunks based on concurrency
  for (let i = 0; i < filesToDownload.length; i += concurrency) {
    chunks.push(filesToDownload.slice(i, i + concurrency));
  }

  console.log(`\t\t\t- Downloading files with concurrency of ${concurrency}`);

  // Process each chunk in parallel
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (file) => {
      try {
        const fileUrl = `${downloadPackageUrl}/${file}`;
        // logger.debug(`Downloading ${fileUrl}`);

        const response = await myFetch(fileUrl, {
          headers: {
            Authorization: `token ${SOURCE_TOKEN}`
          }
        });

        if (!response.ok) {
          throw new Error(`Failed to download file ${fileUrl}, status: ${response.status}`);
        }

        const buffer = await response.arrayBuffer();
        fs.writeFileSync(`packages/${packageName}/${version}/${file}`, Buffer.from(buffer));
        // console.log(`\t\t\t\t- Successfully downloaded ${file}`);
      } catch (downloadError) {
        logger.error(`Error downloading file ${file}:`, downloadError.message);
        throw downloadError;
      }
    }));
  }

  console.log(`\t\t\t\t- Successfully downloaded ${filesToDownload.length} files in parallel`);
}

async function uploadMavenFilesParallel(uploadPackageUrl, packageName, version, filesToUpload) {
  const concurrency = parseInt(process.env.MAVEN_CONCURRENCY || '4');
  const chunks = [];
  // Split files into chunks based on concurrency
  for (let i = 0; i < filesToUpload.length; i += concurrency) {
    chunks.push(filesToUpload.slice(i, i + concurrency));
  }

  console.log(`\t\t\t- Uploading files with concurrency of ${concurrency}`);
  console.log("\t\t\t\t- Upload Package URL: " + uploadPackageUrl)

  // Process each chunk in parallel
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (file) => {
      try {
        const fileContent = fs.readFileSync(`packages/${packageName}/${version}/${file}`);
        const headers = getUploadHeaders(file, fileContent);

        // logger.debug(`Uploading to ${uploadPackageUrl}/${file}`);
        const response = await myFetch(`${uploadPackageUrl}/${file}`, {
          method: 'PUT',
          headers: headers,
          body: fileContent
        });

        if (!response.ok) {
          if (response.status != 409) { //already exists
              throw new Error(`Failed to upload file ${file}, status: ${response.status}, message: ${response.statusText}`);
          }
          else {
            console.log(`\t\t\t\t- ${file} Already exists`)
          }
        }
        // console.log(`\t\t\t- Successfully uploaded ${file}`);
      } catch (uploadError) {
        logger.error(`Error uploading file ${file}:`, uploadError.message);
        throw uploadError;
      }
    }));
  }
  console.log(`\t\t\t\t- Successfully uploaded [${filesToUpload.length}] files in parallel`);
}

async function checkIfVersionExistsInTarget(packageName, PackageVersionID) {
    const headers = {
    Authorization: `token ${TARGET_TOKEN}`,
    'Accept': "application/vnd.github+json"
  };
    const response = await myFetch(`https://api.github.com/orgs/amex-dryrun-mobile/packages/maven/${packageName}/versions`, {
      method: 'GET',
      headers: headers
    });
    let versionList = response.json()
    console.log(versionList)
}

async function getPackageContent(sourceOctokit, sourceOrg, pkg, versionName) {
  const { data: packageContent } = await sourceOctokit.packages.getPackageForOrganization({
    package_type: pkg.package_type,
    package_name: pkg.name,
    org: sourceOrg,
    version: versionName
  });
  return packageContent;
}

function getUploadHeaders(file, fileContent) {
  const headers = {
    Authorization: `token ${TARGET_TOKEN}`,
    'Content-Length': fileContent.length
  };

  if (file.endsWith('.pom')) {
    headers['Content-Type'] = 'application/xml';
  } else if (file.endsWith('.jar')) {
    headers['Content-Type'] = 'application/java-archive';
  } else {
    headers['Content-Type'] = 'application/octet-stream';
  }

  return headers;
}

function getPackageUrls(pkg, packageContent, sourceOrg, targetOrg, versionName) {
  // logger.debug('Package content:', JSON.stringify(packageContent, null, 2));

  const groupId = packageContent.name.split('.').slice(0, -1).join('.');
  const artifactId = packageContent.name.split('.').pop();
  const version = versionName;
  const repository = packageContent.repository.name;

  console.log(`\t\t\t- Group ID: ${groupId}`);
  console.log(`\t\t\t- Artifact ID: ${artifactId}`);
  console.log(`\t\t\t- Version: ${version}`);
  console.log(`\t\t\t- Repository: ${repository}`);

  let downloadBaseUrl, uploadBaseUrl, downloadPackageUrl, uploadPackageUrl;

  downloadBaseUrl = `https://${pkg.package_type}.pkg.github.com/${sourceOrg}/${repository}`;
  uploadBaseUrl = `https://${pkg.package_type}.pkg.github.com/${targetOrg}/${repository}`;
  downloadPackageUrl = `${downloadBaseUrl}/${groupId}/${artifactId}/${version}`;
  uploadPackageUrl = `${uploadBaseUrl}/${groupId}/${artifactId}/${version}`;

  return { groupId, artifactId, repository, downloadBaseUrl, uploadBaseUrl, downloadPackageUrl, uploadPackageUrl };
}

async function listMavenPackageAssets(package_type, package_name, sourceGraphQL, targetGraphQL, org, package_version) {
  const query = `
    query listPackageAssets($org: String!, $packageName: String!, $version: String!) {
      organization(login: $org) {
        packages(first: 1, names: [$packageName]) {
          nodes {
            version(version: $version) {
              files(first: 100) {
                nodes {
                  name
                }
              }
            }
          }
        }
      }
    }`;

  const variables = {
    org: org,
    packageName: package_name,
    version: package_version,
  };
  // logger.info(JSON.stringify(variables, null, 2));
  try {
    console.log(`\t\t\t- Fetching assets for package ${package_name} version ${package_version} in org ${org}`);

    const result = await sourceGraphQL(query, variables);

    if (!result.organization || !result.organization.packages.nodes.length) {
      logger.warn(`No package found for ${package_name} in org ${org}`);
      return [];
    }

    const packageVersion = result.organization.packages.nodes[0].version;
    if (!packageVersion) {
      logger.warn(`Version ${package_version} not found for package ${package_name} in org ${org}`);
      return [];
    }

    const assets = packageVersion.files.nodes.map(node => node.name);
    console.log(`\t\t\t- Found [${assets.length}] assets for package [${package_name}] version [${package_version}]`);
    return assets;
  } catch (error) {
    logger.error(`Error listing package assets for ${package_name} version ${package_version}:`, error);
    if (error.errors) {
      error.errors.forEach(e => logger.error(`GraphQL Error: ${e}`));
    }
    // Log the variables for debugging
    logger.error('Variables passed to GraphQL query:', JSON.stringify(variables, null, 2));
    return [];
  }
}
