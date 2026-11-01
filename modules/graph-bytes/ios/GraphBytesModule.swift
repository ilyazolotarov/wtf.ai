import ExpoModulesCore

/// Installs `globalThis.__wtfGraphBytes` (cpp/GraphBytes.h) on the React Native runtime.
public final class GraphBytesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("GraphBytes")

    // Synchronous: on the JS thread, where the runtime may be touched.
    Function("install") { () -> Bool in
      guard let appContext else {
        throw Exceptions.AppContextLost()
      }
      try appContext.runtime.withUnsafePointee { GraphBytesInstaller.install(inRuntime: $0) }
      return true
    }
  }
}
