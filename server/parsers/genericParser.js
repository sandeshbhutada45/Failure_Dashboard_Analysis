const {
  createFailureObject
} = require("./commonFailure");

async function extractGenericFailures(content) {

  return [

    createFailureObject({

      framework: "generic",

      testName: "Unknown Failure",

      errorMessage: content,

      logs: content
    })
  ];
}

module.exports = {
  extractGenericFailures
};