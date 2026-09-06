//Imports
const processes = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

/**
 * Regression test for the fatal crash of `plugin_languages_indepth`.
 *
 * Symptom (observed 2026-09-04 to 2026-09-06 on Funmatu/Funmatu, workflow runs #472 to #474):
 *   # Fatal JavaScript invalid size error 188720663 (see crbug.com/1201626)
 *   v8::internal::Runtime_GrowArrayElements(...)
 *   Trace/breakpoint trap (core dumped) -> exit code 133
 * The whole action died while `linguist-js` was scanning a cloned repository, so no SVG was
 * rendered at all (a single file could take down the complete run).
 *
 * Root cause: `linguist-js` calls `isbinaryfile` on every candidate file. In isbinaryfile v4,
 * `Reader.next(len)` allocates an array of `len` entries where `len` is a Google Protobuf
 * varint read from the first 512 bytes of the file, without any bounds check. A UTF-8 text file
 * whose leading bytes happen to taste like a length-delimited protobuf message therefore asks V8
 * for an array of hundreds of millions of elements, which aborts the process (no JS exception is
 * thrown, so it cannot be caught by the caller). isbinaryfile 6.0.0 bounds-checks the length
 * against the remaining buffer, and is pinned through the `overrides` field of package.json.
 *
 * The fixture below is byte-exact so the trigger cannot drift. It is a small UTF-8 text file:
 *   0x22                : first byte, read as a protobuf tag with wire type 2 (length-delimited)
 *   0xE3 0x81 0x82 ...  : UTF-8 continuation bytes, read as a ~4.7e8 varint "length"
 *   0xF0 0x9F 0x94 0xB4 : 4-byte UTF-8 sequence, which isbinaryfile v4 counts as "suspicious"
 *                         bytes, the condition that gates the protobuf tasting code path
 */
const fixture = Buffer.from([
  "22e38182e3818420e38193e3828ce381af20697362696e61727966696c6520763420e381ae2070726f746f62756620e5",
  "88a4e5ae9ae38292e8b88fe38280e59bbae5ae9ae38390e382a4e38388e58897e381a7e38199e38082f09f94b4203420",
  "e38390e382a4e38388e69687e5ad97e38292e590abe38281e381a620737573706963696f757320e38292203220e4bba5",
  "e4b88ae381abe38197e381bee38199e380820a",
].join(""), "hex")

//Analysis of a directory, run in a child process so that a fatal V8 error is reported as an exit
//code instead of taking down the test runner with it
const analyze = directory => {
  const script = `
    const {isBinaryFile} = await import("isbinaryfile")
    const linguist = (await import("linguist-js")).default
    const [directory] = process.argv.slice(1)
    const binary = await isBinaryFile(\`\${directory}/sample.py\`)
    const {files:{results}} = await linguist(directory)
    console.log(JSON.stringify({binary, languages:Object.values(results)}))
  `
  const {status, signal, stdout, stderr} = processes.spawnSync("node", ["--input-type=module", "-e", script, directory], {encoding: "utf8", cwd: path.join(__dirname, "..")})
  return {status, signal, stdout, stderr}
}

describe("Languages plugin (indepth analyzer)", () => {
  test("linguist does not abort the process on text files that taste like protobuf", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-linguist-"))
    try {
      fs.writeFileSync(path.join(directory, "sample.py"), fixture)
      const {status, signal, stdout, stderr} = analyze(directory)
      expect({status, signal, stderr}).toStrictEqual({status: 0, signal: null, stderr: ""})
      const {binary, languages} = JSON.parse(stdout)
      expect(binary).toBe(false)
      expect(languages).toStrictEqual(["Python"])
    }
    finally {
      fs.rmSync(directory, {recursive: true, force: true})
    }
  })
})
