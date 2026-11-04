#!/usr/bin/env python3
"""Check genuine native-envelope capture against the independent qualifier."""
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[4]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
if __name__=='__main__':
    fixture=load('fixture',ROOT/'tests/hyperfide/support/native_source_fixture.py')
    result=fixture.run_source_actor(Path(__file__).with_suffix('.mjs'),migrations=['0736-source-control-storage.sql','0737-source-control-metadata.sql','0738-source-control-capabilities.sql','0739-source-control-workspaces.sql','0740-source-control-transformations.sql','0741-source-control-acceptance.sql','0743-source-control-assurance.sql'],timeout=120)
    if result:raise SystemExit(result)
    q=load('qualify',ROOT/'tests/hyperfide/qualify.py')
    native=json.loads((ROOT/'build/source-control/full-case/capture-probe/native.json').read_text())
    q.native_capture(ROOT,native,['native.capture.actual'])
    print(json.dumps({'status':'PASS','scope':'genuine authenticated native capture and independent canonical-envelope verifier'}))
