import ExpoModulesCore
import StoreKit

// The app's own notices on iOS: whether this copy came from TestFlight, for the App Store prompt (UPDATES-SPEC §5.3).
// TestFlight and the App Store install the same binary; only StoreKit tells them apart.

public class AppNoticeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AppNotice")

    /**
     * TestFlight installs belong to StoreKit's sandbox, App Store installs to production, an Xcode run to `.xcode`.
     * The app transaction may need the network the first time; without it the receipt's name decides (TestFlight's is
     * "sandboxReceipt"). A sideloaded build has neither: false.
     */
    AsyncFunction("installedFromTestFlight") { () async -> Bool in
      if let result = try? await AppTransaction.shared {
        switch result {
        case .verified(let transaction), .unverified(let transaction, _):
          return transaction.environment == .sandbox
        }
      }
      return Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
    }
  }
}
