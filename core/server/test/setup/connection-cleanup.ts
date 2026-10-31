import { afterEach } from "vitest";
import { closeTestConnections } from "@hyperfide/db/testing";

afterEach(closeTestConnections);
