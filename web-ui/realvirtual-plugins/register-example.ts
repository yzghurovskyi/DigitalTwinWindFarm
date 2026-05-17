import type { RVViewer } from "realvirtual-web";
import { WindFarmPlugin } from "./windfarm-plugin";

export function registerWindFarmPlugin(viewer: RVViewer) {
  viewer.use(
    new WindFarmPlugin({
      backendUrl: "http://localhost:8080",
      mapping: {
        Turbine_01: "Turbine_01",
        Turbine_02: "Turbine_02",
        Turbine_03: "Turbine_03"
      }
    })
  );
}
