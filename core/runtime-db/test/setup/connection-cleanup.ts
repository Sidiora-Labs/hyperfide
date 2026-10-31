import { afterEach } from "vitest";
import { closeTestConnections } from "../../src/testing.js";

afterEach(closeTestConnections);
