const path = require("path");
const fs = require("fs");
const assert = require("assert");

describe("VTracer Desktop E2E", () => {
  it("should load image, convert, export svg/pdf, and persist outputs", async () => {
    const sampleImage = process.env.SAMPLE_IMAGE
      || path.resolve(__dirname, "..", "..", "..", "webapp", "app", "public", "assets", "samples", "test-logo.png");

    await browser.waitUntil(async () => {
      return browser.execute(() => {
        return !!(window.__VTRACER_E2E && typeof window.__VTRACER_E2E.openImageByPath === "function");
      });
    }, {
      timeout: 30000,
      timeoutMsg: "__VTRACER_E2E helper was not ready",
    });

    const openResult = await browser.executeAsync((targetPath, done) => {
      try {
        window.__VTRACER_E2E.openImageByPath(targetPath)
          .then((result) => done({ ok: true, result }))
          .catch((error) => done({ ok: false, error: String(error) }));
      } catch (error) {
        done({ ok: false, error: String(error) });
      }
    }, sampleImage);
    assert.strictEqual(openResult.ok, true, openResult.error);

    await browser.waitUntil(async () => {
      const count = await $$("#svg path");
      return count.length > 0;
    }, {
      timeout: 120000,
      timeoutMsg: "SVG paths were not generated in time",
    });

    const before = await browser.$("#svg").getHTML(false);

    const precisionSlider = await $("#colorprecision");
    await precisionSlider.setValue("3");
    await precisionSlider.setValue("7");

    const cancelResult = await browser.executeAsync((done) => {
      try {
        window.__VTRACER_E2E.cancelActiveConvert()
          .then((result) => done({ ok: true, result }))
          .catch((error) => done({ ok: false, error: String(error) }));
      } catch (error) {
        done({ ok: false, error: String(error) });
      }
    });
    assert.strictEqual(cancelResult.ok, true, cancelResult.error);

    await browser.waitUntil(async () => {
      const current = await browser.$("#svg").getHTML(false);
      return current !== before;
    }, {
      timeout: 120000,
      timeoutMsg: "SVG did not update after parameter change",
    });

    await $("#export").click();
    const svgExport = await browser.executeAsync((done) => {
      try {
        window.__VTRACER_E2E.getLastExportPath()
          .then((result) => done({ ok: true, result }))
          .catch((error) => done({ ok: false, error: String(error) }));
      } catch (error) {
        done({ ok: false, error: String(error) });
      }
    });
    assert.strictEqual(svgExport.ok, true, svgExport.error);
    assert.ok(svgExport.result.path.toLowerCase().endsWith(".svg"));
    assert.ok(fs.existsSync(svgExport.result.path), `svg export not found: ${svgExport.result.path}`);
    assert.ok(fs.statSync(svgExport.result.path).size > 0, `svg export is empty: ${svgExport.result.path}`);

    await $("#exportPdf").click();
    const pdfExport = await browser.executeAsync((done) => {
      try {
        window.__VTRACER_E2E.getLastExportPath()
          .then((result) => done({ ok: true, result }))
          .catch((error) => done({ ok: false, error: String(error) }));
      } catch (error) {
        done({ ok: false, error: String(error) });
      }
    });
    assert.strictEqual(pdfExport.ok, true, pdfExport.error);
    assert.ok(pdfExport.result.path.toLowerCase().endsWith(".pdf"));
    assert.ok(fs.existsSync(pdfExport.result.path), `pdf export not found: ${pdfExport.result.path}`);
    assert.ok(fs.statSync(pdfExport.result.path).size > 0, `pdf export is empty: ${pdfExport.result.path}`);
  });
});
