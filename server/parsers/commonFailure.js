function createFailureObject(data) {

  return {

    framework:
      data.framework || "unknown",

    testName:
      data.testName || "",

    errorMessage:
      data.errorMessage || "",

    stackTrace:
      data.stackTrace || "",

    screenshotText:
      data.screenshotText || "",

    testSteps:
      data.testSteps || "",

    automationCode:
      data.automationCode || "",

    logs:
      data.logs || "",

    attachments:
      data.attachments || "",

    screenshotDataUrls:
      data.screenshotDataUrls || []
  };
}

module.exports = {
  createFailureObject
};