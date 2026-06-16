function detectFramework(content, fileName = "") {

  const text = content.toLowerCase();

  if (
      text.includes("playwrightreportbase64") ||
      text.includes("@playwright/test")
  ) {
      return "playwright";
  }

  if (
      text.includes("mochawesome") ||
      text.includes("cypress")
  ) {
      return "cypress";
  }

  if (
      text.includes("selenium") ||
      text.includes("webdriver")
  ) {
      return "selenium";
  }

  if (
      text.includes("testng")
  ) {
      return "testng";
  }

  if (
      text.includes("junit")
  ) {
      return "junit";
  }

  // Extent Spark / ExtentReports HTML
  if (
      text.includes("extent") ||
      text.includes("spark-reports") ||
      text.includes("spark reporter") ||
      text.includes("extentreports")
  ) {
      return "extent";
  }

  return "generic";
}

module.exports = {
  detectFramework
};