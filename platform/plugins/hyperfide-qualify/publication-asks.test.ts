import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AskBridge } from "../hyperfide-asks/src/bridge";
import { localGraphHost } from "../hyperfide-asks/src/graph-host-projection";
import { binaryCommand } from "../hyperfide-spec/src/reader";
import { publicationAsks } from "./publication-asks";

it("uses the Asks bridge and binary for blocking permission, grants and refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "hyperfide-publication-asks-"));
  try {
    const binary = join(root, "hyperfide");
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2), path = 'asks.json';
let rows = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : [];
if (a[1] === 'raise') {
  const row = {id: rows.length+1, kind:a[2], title:a[3], body:a[a.indexOf('--body')+1],
    options:['grant','refuse'], state:'open', raised:1, task:null, recommended:null};
  rows.push(row); fs.writeFileSync(path, JSON.stringify(rows)); console.log(JSON.stringify(row));
} else if (a[1] === 'answer') {
  const row = rows.find(row => String(row.id) === a[2]);
  Object.assign(row, {state:'answered', answer:a[3], answered_by:'owner', decided_by_default:false});
  fs.writeFileSync(path, JSON.stringify(rows)); console.log(JSON.stringify(row));
} else console.log(JSON.stringify({asks:rows}));
`, { mode: 0o755 });
    const bridge = new AskBridge(localGraphHost(binary), () => {});
    const service = publicationAsks(root, bridge, binaryCommand(binary));
    expect(await service.policy("permission")).toEqual({ blocks: true });
    for (const answer of ["grant", "refuse"] as const) {
      const ask = await service.raise({kind:"permission", question:"Publish wave?", binding:"head-and-remote",
        options:["grant", "refuse"]});
      expect(ask.status).toBe("open");
      expect(ask.binding).toBe("head-and-remote");
      await bridge.answer(root, ask.id, answer);
      expect(await service.get(ask.id)).toMatchObject({status:"answered", answer, operator:"owner"});
    }
  } finally { await rm(root, {recursive:true, force:true}); }
});
