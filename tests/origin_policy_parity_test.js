const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

async function main() {
  const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  let checks = 0;
  for (const vector of result.vectors) {
    for (const role of ["main", "config"]) {
      let calls = 0;
      const location = new URL(vector.url);
      const sandbox = {URL, location, console, setTimeout, clearTimeout, TextEncoder};
      sandbox.window = sandbox;
      sandbox.globalThis = sandbox;
      sandbox.__YYCamWidgetTransport = {
        request(request) {
          calls += 1;
          return Promise.resolve({requestId: request.requestId, ok: true, data: {
            apiVersion: 1, role, widget: {id: "test", revision: "test", subscriptionId: "test"},
            page: {url: vector.url, origin: location.origin, ...(role === "config" ? {configKey: "default"} : {})},
            environment: {locale: "en-US", colorScheme: "light"}, capabilities: {host: ["context.get"], runtime: []}
          }});
        },
        notify() {}
      };
      assert.strictEqual(vm.runInNewContext(vector.predicate, sandbox), vector.expected, vector.url);
      checks += 1;
      vm.runInNewContext(role === "main" ? vector.mainSDK : vector.configSDK, sandbox);
      assert.strictEqual(Boolean(sandbox.YYCamWidget), vector.expected, vector.url);
      checks += 1;
      if (vector.expected) {
        await sandbox.YYCamWidget.ready;
        await sandbox.YYCamWidget.host.getContext();
        sandbox.location = new URL("https://attacker.example/");
        await assert.rejects(sandbox.YYCamWidget.host.getContext(), error => error.code === "ORIGIN_NOT_ALLOWED");
        checks += 1;
      } else {
        assert.strictEqual(calls, 0, "Denied page must not contact Native");
        checks += 1;
      }
    }
  }
  console.log(`origin_policy_parity_test: ${checks} checks passed`);
}

main().catch(error => {console.error(error); process.exitCode = 1;});
