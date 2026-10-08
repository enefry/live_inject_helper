import Foundation

private struct Fixture: Decodable {
    let policies: [PolicyCase]
    let invalidDeclarations: [[String]]
    let invalidPublicSuffixes: [InvalidPolicyCase]
}

private struct PolicyCase: Decodable {
    let name: String
    let pageURL: URL
    let allowedOrigins: [String]?
    let allowed: [URL]
    let denied: [URL]
}

private struct InvalidPolicyCase: Decodable {
    let pageURL: URL
    let allowedOrigins: [String]
}

private struct VerificationFailure: Error {
    let message: String
}

@main
struct NativeOriginPolicyTest {
    static func main() throws {
        let fixtureURL = URL(fileURLWithPath: CommandLine.arguments[1])
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: fixtureURL))
        var checks = 0
        var vectors: [[String: Any]] = []
        func verify(_ condition: Bool, _ message: String) throws {
            checks += 1
            guard condition else { throw VerificationFailure(message: message) }
        }
        for test in fixture.policies {
            let origin = try requireOrigin(test.pageURL)
            let policy = try WidgetOriginPolicy(origin: origin, allowedOrigins: test.allowedOrigins)
            try verify(origin.matches(test.pageURL), "Exact Origin remains unchanged")
            for (urls, expected) in [(test.allowed, true), (test.denied, false)] {
                for url in urls {
                    try verify(policy.matches(url) == expected, "\(test.name): \(url)")
                    vectors.append([
                        "name": test.name, "url": url.absoluteString, "expected": expected,
                        "rules": try JSONSerialization.jsonObject(with: Data(policy.rulesJSON.utf8)),
                        "predicate": policy.javaScriptPredicate,
                        "mainSDK": WidgetWebSDK.source(for: .main, expectedOrigin: origin, originPolicy: policy),
                        "configSDK": WidgetWebSDK.source(for: .config, expectedOrigin: origin, originPolicy: policy)
                    ])
                }
            }
        }
        let defaultOrigin = try requireOrigin(URL(string: "https://www.pandalive.co.kr/")!)
        for entries in fixture.invalidDeclarations {
            try verify((try? WidgetOriginPolicy(origin: defaultOrigin, allowedOrigins: entries)) == nil, "Invalid declaration accepted: \(entries)")
        }
        for test in fixture.invalidPublicSuffixes {
            let origin = try requireOrigin(test.pageURL)
            try verify((try? WidgetOriginPolicy(origin: origin, allowedOrigins: test.allowedOrigins)) == nil, "Public suffix/tenant boundary accepted: \(test.allowedOrigins)")
        }
        try verify((try? WidgetOriginPolicy(origin: defaultOrigin, allowedOrigins: Array(repeating: "https://login.pandalive.co.kr", count: 17))) == nil, "Count limit")
        for host in ["co.kr", "github.io", "a.ck", "foo.kawasaki.jp"] {
            try verify(WidgetPublicSuffixRules.registrableDomain(host) == nil, "Public suffix: \(host)")
        }
        let manifestURL = fixtureURL.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("pandalive/pandalive.json")
        let data = try Data(contentsOf: manifestURL)
        let manifest = try JSONDecoder().decode(WidgetManifestV1.self, from: data)
        try WidgetManifestValidator.validate(manifest, manifestURL: URL(string: "https://example.com/manifest.json")!)
        let roundtrip = try JSONDecoder().decode(WidgetManifestV1.self, from: JSONEncoder().encode(manifest))
        try verify(roundtrip == manifest, "Manifest roundtrip")
        try verify(manifest.main.contentMode == .mobile, "PandaLive Main requests mobile mode")
        try verify(manifest.configs[.default]?.contentMode == .mobile, "PandaLive Config requests mobile mode")
        var object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        var main = object["main"] as! [String: Any]
        for invalid in [NSNull(), [], "https://pandalive.co.kr", ["https://*.co.kr"]] as [Any] {
            main["allowedOrigins"] = invalid
            object["main"] = main
            let invalidData = try JSONSerialization.data(withJSONObject: object)
            do {
                let invalidManifest = try JSONDecoder().decode(WidgetManifestV1.self, from: invalidData)
                try WidgetManifestValidator.validate(invalidManifest, manifestURL: URL(string: "https://example.com/manifest.json")!)
                throw VerificationFailure(message: "Invalid manifest accepted")
            } catch is WidgetManifestError {
                checks += 1
            } catch is DecodingError {
                checks += 1
            }
        }
        main.removeValue(forKey: "allowedOrigins")
        main.removeValue(forKey: "contentMode")
        object["main"] = main
        var configs = object["configs"] as! [String: Any]
        var defaultConfig = configs["default"] as! [String: Any]
        for invalid in [NSNull(), [], "https://pandalive.co.kr", ["https://*.co.kr"]] as [Any] {
            defaultConfig["allowedOrigins"] = invalid
            configs["default"] = defaultConfig
            object["configs"] = configs
            let invalidData = try JSONSerialization.data(withJSONObject: object)
            do {
                let invalidManifest = try JSONDecoder().decode(WidgetManifestV1.self, from: invalidData)
                try WidgetManifestValidator.validate(invalidManifest, manifestURL: URL(string: "https://example.com/manifest.json")!)
                throw VerificationFailure(message: "Invalid Config manifest accepted")
            } catch is WidgetManifestError {
                checks += 1
            } catch is DecodingError {
                checks += 1
            }
        }
        defaultConfig.removeValue(forKey: "allowedOrigins")
        defaultConfig.removeValue(forKey: "contentMode")
        configs["default"] = defaultConfig
        object["configs"] = configs
        let legacy = try JSONDecoder().decode(WidgetManifestV1.self, from: JSONSerialization.data(withJSONObject: object))
        try verify(legacy.main.allowedOrigins == nil, "Legacy manifest")
        try verify(legacy.configs[.default]?.allowedOrigins == nil, "Legacy Config manifest")
        let config = manifest.configs[.default]!
        let page = WidgetPageDefinition(url: config.url, userAgent: config.userAgent, inject: config.inject, allowedOrigins: config.allowedOrigins)
        let pageRoundtrip = try JSONDecoder().decode(WidgetPageDefinition.self, from: JSONEncoder().encode(page))
        try verify(pageRoundtrip == page, "Cached page policy roundtrip")
        let snapshot = WidgetSnapshot(subscriptionID: "test", manifestURL: URL(string: "https://example.com/manifest.json")!, manifest: manifest,
                                      main: WidgetMainSnapshot(definition: manifest.main), configs: [.default: WidgetPageSnapshot(definition: page)])
        let changed = WidgetSnapshot(subscriptionID: "test", manifestURL: snapshot.manifestURL, manifest: manifest, main: snapshot.main,
                                     configs: [.default: WidgetPageSnapshot(definition: WidgetPageDefinition(url: page.url))])
        try verify(snapshot.executionFingerprint(for: .default) != changed.executionFingerprint(for: .default), "Policy changes invalidate Config fingerprint")
        try verify(legacy.main.contentMode == nil, "Legacy Main retains recommended mode")
        try verify(legacy.configs[.default]?.contentMode == nil, "Legacy Config retains recommended mode")
        try verify(pageRoundtrip.contentMode == nil, "Legacy cached page retains recommended mode")
        var modeDigests = Set<String>()
        var modeFingerprints = Set<String>()
        for mode in [nil, WidgetWebContentMode.desktop, WidgetWebContentMode.mobile] {
            var pageObject: [String: Any] = ["url": page.url.absoluteString, "title": "Config", "userAgent": "Example Widget UA"]
            if let mode {
                pageObject["contentMode"] = mode.rawValue
            }
            let pageData = try JSONSerialization.data(withJSONObject: pageObject)
            let mainDefinition = try JSONDecoder().decode(WidgetMainPageDefinition.self, from: pageData)
            let configDefinition = try JSONDecoder().decode(WidgetConfigPageDefinition.self, from: pageData)
            let cachedDefinition = try JSONDecoder().decode(WidgetPageDefinition.self, from: pageData)
            try verify(mainDefinition.contentMode == mode, "Main decodes content mode")
            try verify(configDefinition.contentMode == mode, "Config decodes content mode")
            try verify(cachedDefinition.contentMode == mode, "Cached page decodes content mode")
            try verify(mainDefinition.userAgent == "Example Widget UA", "Main mode preserves custom UA")
            try verify(configDefinition.userAgent == "Example Widget UA", "Config mode preserves custom UA")
            try verify(try JSONDecoder().decode(WidgetMainPageDefinition.self, from: JSONEncoder().encode(mainDefinition)) == mainDefinition, "Main mode roundtrip")
            try verify(try JSONDecoder().decode(WidgetConfigPageDefinition.self, from: JSONEncoder().encode(configDefinition)) == configDefinition, "Config mode roundtrip")
            try verify(try JSONDecoder().decode(WidgetPageDefinition.self, from: JSONEncoder().encode(cachedDefinition)) == cachedDefinition, "Cached mode roundtrip")
            let modeManifest = WidgetManifestV1(id: "mode.test", revision: "1", name: "Mode Test",
                                                main: mainDefinition, configs: [.default: configDefinition])
            try WidgetManifestValidator.validate(modeManifest, manifestURL: snapshot.manifestURL)
            let modeSnapshot = WidgetSnapshot(subscriptionID: "mode.test", manifestURL: snapshot.manifestURL,
                                              manifest: modeManifest, main: WidgetMainSnapshot(definition: mainDefinition),
                                              configs: [.default: WidgetPageSnapshot(definition: cachedDefinition)])
            let restored = try JSONDecoder().decode(WidgetSnapshot.self, from: JSONEncoder().encode(modeSnapshot))
            try verify(restored.main.definition.contentMode == mode, "Restored Main mode")
            try verify(restored.configs[.default]?.definition.contentMode == mode, "Restored Config mode")
            modeDigests.insert(modeSnapshot.contentDigest)
            if let fingerprint = modeSnapshot.executionFingerprint(for: .default) {
                modeFingerprints.insert(fingerprint)
            }
            if mode == nil {
                let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(mainDefinition)) as! [String: Any]
                try verify(encoded["contentMode"] == nil, "Omitted mode remains omitted when encoded")
            }
        }
        try verify(modeDigests.count == 3, "Mode-only changes invalidate Snapshot digest")
        try verify(modeFingerprints.count == 3, "Mode-only changes invalidate Config fingerprint")
        let independentManifest = WidgetManifestV1(id: "mode.independent", revision: "1", name: "Independent Modes",
                                                   main: WidgetMainPageDefinition(url: page.url, contentMode: .desktop),
                                                   configs: [.default: WidgetConfigPageDefinition(title: "Config", url: page.url, contentMode: .mobile)])
        let independentRoundtrip = try JSONDecoder().decode(WidgetManifestV1.self, from: JSONEncoder().encode(independentManifest))
        try verify(independentRoundtrip.main.contentMode == .desktop, "Main can request desktop independently")
        try verify(independentRoundtrip.configs[.default]?.contentMode == .mobile, "Config can request mobile independently")
        for invalid in [NSNull(), "", "Desktop", "recommended", 1, true, [], [:]] as [Any] {
            let invalidData = try JSONSerialization.data(withJSONObject: ["url": page.url.absoluteString, "title": "Config", "contentMode": invalid])
            for decode in [
                { _ = try JSONDecoder().decode(WidgetMainPageDefinition.self, from: invalidData) },
                { _ = try JSONDecoder().decode(WidgetConfigPageDefinition.self, from: invalidData) },
                { _ = try JSONDecoder().decode(WidgetPageDefinition.self, from: invalidData) }
            ] {
                do {
                    try decode()
                    throw VerificationFailure(message: "Invalid contentMode accepted")
                } catch is DecodingError {
                    checks += 1
                }
            }
        }
        let output: [String: Any] = ["checks": checks, "vectors": vectors]
        let outputData = try JSONSerialization.data(withJSONObject: output)
        try outputData.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        print("native_origin_policy_test: \(checks) checks passed")
    }

    private static func requireOrigin(_ url: URL) throws -> WidgetOrigin {
        guard let origin = WidgetOrigin(url: url) else { throw VerificationFailure(message: "Invalid test origin") }
        return origin
    }
}
