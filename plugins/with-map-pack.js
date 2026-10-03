// Embeds an offline map pack built by tools/tiles (out/<region>/) in the iOS app as
// `map-pack.bundle`, an interim until hosted in-app downloads exist (SPEC §3.8).
// A `.bundle` directory is copied whole by Xcode, so the pack keeps its folder layout;
// the app reads it from `Paths.bundle`. Never edit ios/ by hand; prebuild applies this.
const fs = require("fs");
const path = require("path");
const { IOSConfig, withXcodeProject } = require("expo/config-plugins");

const BUNDLE_NAME = "map-pack.bundle";

module.exports = function withMapPack(config, props = {}) {
  return withXcodeProject(config, (cfg) => {
    const { projectRoot, platformProjectRoot, projectName } = cfg.modRequest;
    const source = path.resolve(projectRoot, props.source ?? "tools/tiles/out/chernihiv");
    if (!fs.existsSync(path.join(source, "manifest.json"))) {
      console.warn(`[with-map-pack] No pack at ${source}; building without a bundled map.`);
      return cfg;
    }
    const filepath = `${projectName}/${BUNDLE_NAME}`;
    const dest = path.join(platformProjectRoot, filepath);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(source, dest, { recursive: true });
    if (!cfg.modResults.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath,
        groupName: projectName,
        project: cfg.modResults,
        isBuildFile: true,
      });
    }
    return cfg;
  });
};
