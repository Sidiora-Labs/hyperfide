import { definePluginApp } from "@hyperfide/plugin-sdk/app";
import { FleetView } from "./src/fleet-view/view.js";

import { ImageBuilderView } from "./src/image-builder/view.js";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "fleet",
    title: "Fleet",
    icon: "Server",
    path: "fleet",
    component: FleetView,
  });
  app.slots.navPanel({
    id: "image-builder",
    title: "Image builder",
    icon: "Server",
    path: "image-builder",
    component: ImageBuilderView,
  });
});
