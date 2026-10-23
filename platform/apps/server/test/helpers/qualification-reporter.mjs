// Surface failures while the dual-dialect qualification suites are still running.
export default class QualificationReporter {
  onTestCaseResult(test) {
    const result = test.result();
    if (result.state === "failed") {
      console.error(
        "Qualification failure",
        test.module.moduleId,
        test.fullName,
        JSON.stringify(result.errors),
      );
    }
  }
}
