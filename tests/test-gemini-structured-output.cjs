const assert = require('node:assert/strict');
async function main() {
    const { convertAnthropicToGoogle } = await import('../src/format/request-converter.js');
    const { buildCloudCodeRequest } = await import('../src/cloudcode/request-builder.js');
    const { geminiOutputSchema, assertGeminiStructuredResponse } = await import('../src/format/structured-output.js');
    const base = { model: 'gemini-3.8-flash-tiered', messages: [{role:'user',content:'Return JSON'}], max_tokens:1024 };
    const schema = {type:'object',properties:{value:{type:'string',enum:['ok']},list:{type:'array',items:{type:'integer'}}},required:['value','list'],additionalProperties:false};
    const req = {...base,output_config:{format:{type:'json_schema',schema}}};
    const original=JSON.stringify(schema);
    const cfg=convertAnthropicToGoogle(req).generationConfig;
    assert.equal(cfg.responseMimeType,'application/json');
    assert.deepEqual(cfg.responseSchema,{type:'OBJECT',properties:{value:{type:'STRING',enum:['ok']},list:{type:'ARRAY',items:{type:'INTEGER'}}},required:['value','list']});
    assert.equal(cfg.responseJsonSchema,undefined);
    assert.equal(JSON.stringify(schema),original);
    assert.deepEqual(buildCloudCodeRequest(req,'test-project','test@example.invalid').request.generationConfig.responseSchema,cfg.responseSchema);
    for(const r of [base,{...base,output_config:{effort:'low'}},{...base,output_config:{format:null}},{...req,model:'claude-sonnet-4-6'}]) assert.equal(geminiOutputSchema(r),undefined);
    for(const s of [{...schema,anyOf:[schema]},{type:'object',properties:{x:{$ref:'#/$defs/x'}},$defs:{x:{type:'string'}}},{...schema,properties:{value:{type:['string','null']}}},{...schema,properties:{value:{type:'string',minLength:2}}}]) assert.throws(()=>convertAnthropicToGoogle({...base,output_config:{format:{type:'json_schema',schema:s}}}),/invalid_request_error: output_config/);
    // Streaming (Claude Code side queries): translatable schemas are applied, others are dropped, never a 400.
    const hookSchema={type:'object',properties:{ok:{type:'boolean'},reason:{type:'string'},impossible:{type:'boolean'}},required:['ok','reason'],additionalProperties:false};
    const hookReq={...base,stream:true,output_config:{effort:'high',format:{type:'json_schema',schema:hookSchema}}};
    assert.deepEqual(convertAnthropicToGoogle(hookReq).generationConfig.responseSchema,{type:'OBJECT',properties:{ok:{type:'BOOLEAN'},reason:{type:'STRING'},impossible:{type:'BOOLEAN'}},required:['ok','reason']});
    assert.deepEqual(geminiOutputSchema({...req,stream:true}),cfg.responseSchema);
    const badStream={...base,stream:true,output_config:{format:{type:'json_schema',schema:{...schema,anyOf:[schema]}}}};
    assert.equal(geminiOutputSchema(badStream),undefined);
    assert.equal(convertAnthropicToGoogle(badStream).generationConfig.responseSchema,undefined);
    assert.equal(geminiOutputSchema({...req,stream:true,tools:[{name:'x'}]}),undefined);
    assert.throws(()=>geminiOutputSchema({...req,tools:[{name:'x'}]}),/invalid_request_error: output_config/);
    const response=text=>({stop_reason:'end_turn',content:[{type:'text',text}]});
    assert.doesNotThrow(()=>assertGeminiStructuredResponse(req,response('{"value":"ok","list":[1,2]}')));
    for(const t of ['', 'not JSON','{"value":"wrong","list":[]}','{"value":"ok","list":[1.5]}','{"value":"ok"}','{"value":"ok","list":[],"extra":1}']) assert.throws(()=>assertGeminiStructuredResponse(req,response(t)),/empty or invalid structured response/);
    assert.doesNotThrow(()=>assertGeminiStructuredResponse(req,{stop_reason:'max_tokens',content:[]}));
    // A fallback to a Claude model never sent the schema, so its reply isn't held to it
    assert.doesNotThrow(()=>assertGeminiStructuredResponse(req,{model:'claude-sonnet-4-6',stop_reason:'end_turn',content:[{type:'text',text:'Here you go: {"value":"ok"}'}]}));
    assert.throws(()=>assertGeminiStructuredResponse(req,{model:req.model,stop_reason:'end_turn',content:[{type:'text',text:'not JSON'}]}),/empty or invalid structured response/);
    console.log('PASS legacy schema mapping, unsupported union/ref/types/constraints, stream/tools, Cloud Code payload, original schema unchanged, output validation, Claude unchanged');
}
main().catch(e=>{console.error(e);process.exit(1)});
