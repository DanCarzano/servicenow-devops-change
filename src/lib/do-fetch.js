const core = require('@actions/core');
const axios = require('axios');

async function doFetch({
  changeCreationStartTime,
  instanceUrl,
  toolId,
  username,
  passwd,
  token,
  jobname,
  prevPollChangeDetails,
  changeCreationTimeOut,
  abortOnChangeCreationFailure,
  runId,
  runAttempt,
  repository,
  workflow
}) {

  const codesAllowedArr = '200,201,400,401,403,404,500'.split(',').map(Number);
  const pipelineName = `${repository}/${workflow}`;
  const buildNumber = runId;
  const attemptNumber = runAttempt;

  let endpoint = '';
  let httpHeaders = {};

  let response = {};
  let status = false;
  let changeStatus = {};
  let responseCode = 500;

  try {
    // URL-encode parameters to handle special characters
    const encodedPipelineName = encodeURIComponent(pipelineName);
    const encodedJobName = encodeURIComponent(jobname);

    if (token !== '') {
      endpoint = `${instanceUrl}/api/sn_devops/v2/devops/orchestration/changeStatus` +
        `?toolId=${toolId}` +
        `&stageName=${encodedJobName}` +
        `&pipelineName=${encodedPipelineName}` +
        `&buildNumber=${buildNumber}` +
        `&attemptNumber=${attemptNumber}`;
      const defaultHeadersForToken = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'sn_devops.DevOpsToken ' + `${toolId}:${token}`
      };
      httpHeaders = { headers: defaultHeadersForToken };
    } else {
      endpoint = `${instanceUrl}/api/sn_devops/v1/devops/orchestration/changeStatus` +
        `?toolId=${toolId}` +
        `&stageName=${encodedJobName}` +
        `&pipelineName=${encodedPipelineName}` +
        `&buildNumber=${buildNumber}` +
        `&attemptNumber=${attemptNumber}`;
      const tokenBasicAuth = `${username}:${passwd}`;
      const encodedTokenForBasicAuth = Buffer.from(tokenBasicAuth).toString('base64');

      const defaultHeadersForBasicAuth = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + `${encodedTokenForBasicAuth}`
      };
      httpHeaders = { headers: defaultHeadersForBasicAuth };
    }

    core.debug(`Endpoint URL: ${endpoint}`);
    core.debug(`HTTP Headers: ${JSON.stringify(httpHeaders)}`);
    core.debug('Parameters:');
    core.debug(`  pipelineName: ${pipelineName}`);
    core.debug(`  buildNumber: ${buildNumber}`);
    core.debug(`  attemptNumber: ${attemptNumber}`);
    core.debug(`  jobname: ${jobname}`);

    response = await axios.get(endpoint, httpHeaders);
    status = true;
  } catch (err) {
    core.debug(`Error response: ${JSON.stringify(err.response?.data)}`);
    core.debug(`Error status: ${err.response?.status}`);

    if (!err.response) {
      throw new Error("500");
    }

    if (!codesAllowedArr.includes(err.response.status)) {
      throw new Error("500");
    }

    if (err.response.status == 500) {
      throw new Error("500");
    }

    if (err.response.status == 400) {
      let responseData = err.response.data;
      if (responseData && responseData.result && responseData.result.errorMessage) {
        // Other technical error messages
        let errMsg = responseData.result.errorMessage;
        throw new Error(JSON.stringify({ "status": "error", "details": errMsg }));
      }

      throw new Error("400");
    }

    if (err.response.status == 401) {
      throw new Error("401");
    }

    if (err.response.status == 403) {
      throw new Error("403");
    }

    if (err.response.status == 404) {
      throw new Error("404");
    }
  }

  if (status) {
    core.debug("[ServiceNow DevOps], Polling started to fetch change info.");
    try {
      responseCode = response.status;
    } catch (error) {
      core.setFailed('\nCould not read response code from API response: ' + error);
      throw new Error("500");
    }

    try {
      changeStatus = response.data.result;
    } catch (error) {
      core.setFailed('\nCould not read change status details from API response: ' + error);
      throw new Error("500");
    }

    let currChangeDetails = changeStatus.details;
    let changeState = currChangeDetails.status;

    /**
     * Check for changeCreationTimeOut.
     * If changeCreationTimeOut happened and change does not get created,
     * then we need to terminate the step based on abortOnChangeCreationFailure flag.
     */
    if (Object.keys(currChangeDetails).length === 0) {
      if ((+new Date() - changeCreationStartTime) > (changeCreationTimeOut * 1000)) {
        if (abortOnChangeCreationFailure) {
          let errMsg = `Timeout after ${changeCreationTimeOut} seconds. Workflow execution is aborted since abortOnChangeCreationFailure flag is true`;
          throw new Error(JSON.stringify({ "status": "error", "details": errMsg }));
        } else {
          console.error('\n    \x1b[38;5;214m Timeout occurred after ' + changeCreationTimeOut + ' seconds but pipeline will continue since abortOnChangeCreationFailure flag is false \x1b[38;5;214m');
          throw new Error("ChangeCreationFailure_DontFailTheStep");
        }
      }
    }

    if (currChangeDetails) {
      if (currChangeDetails.number)
        core.setOutput('change-request-number', currChangeDetails.number);
      if (currChangeDetails.sys_id)
        core.setOutput('change-request-sys-id', currChangeDetails.sys_id);
    }

    /**
     * 1. In case of change not created
     * 2. In case of change created and not in implement state
     */
    if (responseCode == 201) {
      if (changeState == "pending_decision") {
        if (isChangeDetailsChanged(prevPollChangeDetails, currChangeDetails)) {
          console.log('\n \x1b[1m\x1b[32m' + JSON.stringify(currChangeDetails) + '\x1b[0m\x1b[0m');
        }
        throw new Error(JSON.stringify({ "statusCode": "201", "details": currChangeDetails }));
      } else if ((changeState == "failed") || (changeState == "error")) {
        throw new Error(JSON.stringify({ "status": "error", "details": currChangeDetails.details }));
      } else if (changeState == "rejected" || changeState == "canceled_by_user") {
        if (isChangeDetailsChanged(prevPollChangeDetails, currChangeDetails)) {
          console.log('\n \x1b[1m\x1b[32m' + JSON.stringify(currChangeDetails) + '\x1b[0m\x1b[0m');
        }
        throw new Error("202");
      } else {
        throw new Error("201");
      }
    } else if (responseCode == 200) { // In case of change created and in implemented state
      if (isChangeDetailsChanged(prevPollChangeDetails, currChangeDetails)) {
        console.log('\n \x1b[1m\x1b[32m' + JSON.stringify(currChangeDetails) + '\x1b[0m\x1b[0m');
      }
      console.log('\n****Change is Approved.');
    }
  } else {
    throw new Error("500");
  }

  return true;
}

function isChangeDetailsChanged(prevPollChangeDetails, currChangeDetails) {
  if (Object.keys(currChangeDetails).length !== Object.keys(prevPollChangeDetails).length) {
    return true;
  }
  for (let field of Object.keys(currChangeDetails)) {
    if (currChangeDetails[field] !== prevPollChangeDetails[field]) {
      return true;
    }
  }
  return false;
}

module.exports = { doFetch };