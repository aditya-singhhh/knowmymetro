import ExpoModulesCore

/// iOS does not let apps read mobile tower identities, so the recorder uses GPS and motion only.
public class CellInfoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CellInfo")

    AsyncFunction("getCellsAsync") { () -> [[String: Any]] in
      return []
    }
  }
}
