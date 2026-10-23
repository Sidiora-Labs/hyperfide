import { definePluginApp } from "@hyperfide/plugin-sdk/app";
import { FleetView } from "./src/fleet-view/view.js";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "fleet",
    title: "Fleet",
    icon: "Server",
    path: "fleet",
    component: FleetView,
  });
});
