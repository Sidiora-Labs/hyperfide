#!/usr/bin/env node
import { runHyperfideHostDaemon, runLauncherEntry } from "../launcher.js";

runLauncherEntry(runHyperfideHostDaemon);
