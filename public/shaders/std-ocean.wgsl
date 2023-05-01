struct VertexOutput {
    // TODO(@darzu): can we get rid of worldPos if we do our own depth invert?
    // @location(0) @interpolate(flat) normal : vec3<f32>,
    // @location(1) @interpolate(flat) color : vec3<f32>,
    // @location(2) @interpolate(flat) worldPos: vec4<f32>,
    // @location(3) @interpolate(flat) uv: vec2<f32>,
    // @location(0) normal : vec3<f32>,
    @location(0) color : vec3<f32>,
    // @location(2) worldPos: vec4<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) @interpolate(flat) surface: u32,
    @location(3) @interpolate(flat) id: u32,
    @builtin(position) position : vec4<f32>,
};

@vertex
fn vert_main(input: VertexInput) -> VertexOutput {
    let position = input.position;
    let uv = input.uv;
    let color = input.color;
    let normal = input.normal;
    let tangent = input.tangent;
    let perp = cross(tangent, normal);

    let flattenedPos = vec3<f32>(uv.x - 1.0, 0, uv.y) * 1000;
    // TODO(@darzu): we're not totally sure about x,y,z vs normal,tangent,perp
    let surfBasis = mat3x3<f32>(perp, normal, tangent);
    // TODO(@darzu): PERF. don't transform twice..
    let oldWorldPos = meshUni.transform * vec4<f32>(position, 1.0);
    let gerst = gerstner(oldWorldPos.zx, scene.time);
    // let gerst = gerstner(uv * 1000, scene.time * .001);

    // let displacedPos = position;
    let displacedPos = position + surfBasis * gerst[0];

    // TODO(@darzu): oh hmm the UVs also need to be displaced

    //let displacedPos = flattenedPos + gerst[0];
    let gerstNormal = surfBasis * gerst[1];
    //let gerstNormal = gerst[1];
    // let displacedPos = flattenedPos + wave1;
    // let displacedPos = position + wave0;
    // let displacedPos = position + wave1;
    // let displacedPos = flattenedPos + wave0 + wave0a;// wave0 + wave0a + wave1; //+ wave2;

    var output : VertexOutput;
    let worldPos: vec4<f32> = meshUni.transform * vec4<f32>(displacedPos, 1.0);

    let finalPos = worldPos;

    // output.worldPos = finalPos;
    output.position = scene.cameraViewProjMatrix * finalPos;
    // TODO: use inverse-transpose matrix for normals as per: https://learnopengl.com/Lighting/Basic-Lighting
    //output.normal = normalize(meshUni.transform * vec4<f32>(normal, 0.0)).xyz;
    // output.normal = normalize(meshUni.transform * vec4<f32>(gerstNormal, 0.0)).xyz;
    output.color = color + meshUni.tint;
    // output.color = tangent; // DBG TANGENT
    //output.color = output.normal;
    output.surface = input.surfaceId;
    output.id = meshUni.id;

    output.uv = uv;

    return output;
}

struct FragOut {
  @location(0) color: vec4<f32>,
  // @location(1) normal: vec4<f32>,
  // @location(2) position: vec4<f32>,
  @location(1) surface: vec2<u32>,
}

@fragment
fn frag_main(input: VertexOutput) -> FragOut {
    
    var out: FragOut;
    out.color = vec4<f32>(input.color, 1.0);

    // out.color = vec4<f32>(normal, 1.0);

    const fresnel = 1.0;

    // TODO(@darzu): this normal is way different then std-mesh's normal
    // out.normal = vec4(normalize((scene.cameraViewProjMatrix * vec4<f32>(input.normal, 0.0)).xyz), 1.0);
    // out.normal = vec4<f32>(normalize(input.normal), fresnel);
    // out.position = input.worldPos;

    out.surface.r = input.surface;
    out.surface.g = input.id;

    return out;
}
