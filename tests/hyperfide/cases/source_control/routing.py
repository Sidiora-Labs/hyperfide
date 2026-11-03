#!/usr/bin/env python3
"""Exercise source-service owner admission after routing is configured."""
import importlib.util
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
spec=importlib.util.spec_from_file_location('source_fixture',ROOT/'tests/hyperfide/support/native_source_fixture.py')
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)

def main():
    return fixture.run_source_actor(ROOT/'tests/hyperfide/support/native_source_routing.mjs',migrations=['0736-source-control-storage.sql','0737-source-control-metadata.sql','0738-source-control-capabilities.sql','0739-source-control-workspaces.sql','0740-source-control-transformations.sql','0741-source-control-acceptance.sql','0743-source-control-assurance.sql','0746-source-control-retention.sql','0752-source-control-recovery.sql'])

if __name__=='__main__':raise SystemExit(main())
