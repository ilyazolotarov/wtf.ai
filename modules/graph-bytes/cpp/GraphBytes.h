// Random access reads of files for JavaScript on any runtime: the navigator's worker runtime reads its road graph
// through it (NAVIGATOR-SPEC §9), where Expo modules don't run. Installed on the React Native runtime as
// `globalThis.__wtfGraphBytes`; a worklet that captures it gets the same object on its own runtime.
#pragma once

#include <jsi/jsi.h>

#include <vector>

namespace wtf {

/** open(path) → handle, size(handle), read(handle, offset, length) → ArrayBuffer, close(handle). */
class GraphBytes : public facebook::jsi::HostObject {
 public:
  facebook::jsi::Value get(facebook::jsi::Runtime &rt, const facebook::jsi::PropNameID &name) override;
  std::vector<facebook::jsi::PropNameID> getPropertyNames(facebook::jsi::Runtime &rt) override;

  /** Sets `globalThis.__wtfGraphBytes` on this runtime. */
  static void install(facebook::jsi::Runtime &rt);
};

} // namespace wtf
