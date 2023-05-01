struct VertexOutput {
    @builtin(position) position : vec4<f32>,
    @location(0) @interpolate(flat) normal : vec3<f32>,
    // @location(2) worldPos: vec3<f32>,
    @location(1) @interpolate(flat) color : vec3<f32>,
    @location(2) @interpolate(flat) surfAndObjId: u32,
    // @location(1) @interpolate(flat) color : u32,
    // @location(4) @interpolate(flat) id: u32,
};

@vertex
fn vert_main(input: VertexInput) -> VertexOutput {

    var output : VertexOutput;
    
    let worldPos: vec4<f32> = meshUni.transform * vec4<f32>(input.position, 1.0);

    // output.worldPos = worldPos.xyz;
    output.position = scene.cameraViewProjMatrix * worldPos;
    // TODO(@darzu): for non-uniform scaling, we need to use inverse-transpose matrix for normals as per: https://learnopengl.com/Lighting/Basic-Lighting
    output.normal = (meshUni.transform * vec4<f32>(input.normal, 0.0)).xyz;
    // let color = input.color + meshUni.tint;
    // output.color = 100;
    output.color = input.color + meshUni.tint;

    output.surfAndObjId = ((input.surfaceId << 16) >> 16) | (meshUni.id << 16);
    // output.id = meshUni.id;

    return output;
}

struct FragOut {
  @location(0) color: vec4<f32>,
  @location(1) normal: vec4<f32>,
  // @location(2) position: vec4<f32>,
  @location(2) surface: vec2<u32>,
}

@fragment
fn frag_main(input: VertexOutput) -> FragOut {
    // let normal = normalize(input.normal);

    var out: FragOut;
    out.color = vec4<f32>(input.color, 1.0);
    // out.color = vec4<f32>(f32(input.color / 255), f32(input.color / 255), f32(input.color / 255), 1.0);
    // out.position = vec4(input.worldPos, 0.0);
    // out.position = vec4(0.0, 0.0, 0.0, 0.0);

    const fresnel = 0.0;

    out.normal = vec4<f32>(normalize(input.normal), fresnel);
    // out.normal = vec4<f32>(0.0, 1.0, 0.0, 0.0);
    // out.normal = vec4(normalize((scene.cameraViewProjMatrix * vec4<f32>(input.normal, 0.0)).xyz), 1.0);
    let surfAndObjId = input.surfAndObjId;
    out.surface.r = ((surfAndObjId << 16) >> 16);
    out.surface.g = (surfAndObjId >> 16);

    return out;
}
