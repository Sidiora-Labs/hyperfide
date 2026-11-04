import path from 'node:path';
import {createNativeAcceptanceFixture} from '../../support/native_source_acceptance_fixture.mjs';
import {captureNativeSource} from './native_capture.mjs';
const f=await createNativeAcceptanceFixture();
try{await captureNativeSource({client:f.client,context:f.context,revisionId:f.base.revision_id,workspaceRoot:f.ROOT,outputDirectory:path.join(f.ROOT,'build/source-control/full-case/capture-probe'),assertionIds:['native.capture.actual'],toolchain:[process.execPath]});}finally{await f.close();}
