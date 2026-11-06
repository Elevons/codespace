/**
 * The slice of the Babylon.js global the page uses. The page loads Babylon from a
 * CDN as the global `BABYLON`, so there is no module to import types from; this
 * file types the members the code touches, and nothing more.
 */
declare namespace BABYLON
{
    class Vector3
    {
        x: number;
        y: number;
        z: number;
        constructor(x?: number, y?: number, z?: number);
        static Zero(): Vector3;
        static Up(): Vector3;
        static Center(a: Vector3, b: Vector3): Vector3;
        static Distance(a: Vector3, b: Vector3): number;
        static DistanceSquared(a: Vector3, b: Vector3): number;
        static LerpToRef(a: Vector3, b: Vector3, t: number, ref: Vector3): void;
        static Minimize(a: Vector3, b: Vector3): Vector3;
        static Maximize(a: Vector3, b: Vector3): Vector3;
        static Project(vector: Vector3, world: Matrix, transform: Matrix, viewport: Viewport): Vector3;
        clone(): Vector3;
        copyFrom(other: Vector3): Vector3;
        add(other: Vector3): Vector3;
        subtract(other: Vector3): Vector3;
        scale(factor: number): Vector3;
        normalize(): Vector3;
        set(x: number, y: number, z: number): Vector3;
        lengthSquared(): number;
    }

    class Color3
    {
        r: number;
        g: number;
        b: number;
        constructor(r?: number, g?: number, b?: number);
        static FromHexString(hex: string): Color3;
        static White(): Color3;
        scale(factor: number): Color3;
        toColor4(alpha?: number): Color4;
    }

    class Color4
    {
        r: number;
        g: number;
        b: number;
        a: number;
        constructor(r?: number, g?: number, b?: number, a?: number);
    }

    class Matrix
    {
        static IdentityReadOnly: Matrix;
    }

    class Quaternion
    {
        constructor(x?: number, y?: number, z?: number, w?: number);
        static FromUnitVectorsToRef(from: Vector3, to: Vector3, ref: Quaternion): number;
    }

    class Viewport
    {
        toGlobal(width: number, height: number): Viewport;
    }

    class Node
    {
        position: Vector3;
        scaling: Vector3;
        rotation: Vector3;
        rotationQuaternion: Quaternion | null;
        parent: Node | null;
        metadata: unknown;
        material: Material | null;
        dispose(): void;
        clone(name: string): Node;
    }

    class Mesh extends Node
    {
        isPickable: boolean;
        renderOutline: boolean;
        outlineColor: Color3;
        outlineWidth: number;
        edgesColor: Color4;
        edgesWidth: number;
        color: Color3;
        alpha: number;
        static DOUBLESIDE: number;
        enableEdgesRendering(): void;
        getBoundingInfo(): { boundingBox: { minimumWorld: Vector3; maximumWorld: Vector3 } };
    }

    class Material
    {
        alpha: number;
    }

    class StandardMaterial extends Material
    {
        constructor(name: string, scene: Scene);
        diffuseColor: Color3;
        emissiveColor: Color3;
        specularColor: Color3;
        disableLighting: boolean;
        backFaceCulling: boolean;
    }

    class Engine
    {
        constructor(canvas: HTMLCanvasElement, antialias?: boolean, options?: Record<string, unknown>, adaptToDeviceRatio?: boolean);
        resize(): void;
        runRenderLoop(callback: () => void): void;
        getAspectRatio(camera: Camera): number;
    }

    class Camera
    {
        fov: number;
        radius: number;
        viewport: Viewport;
    }

    class ArcRotateCamera extends Camera
    {
        constructor(name: string, alpha: number, beta: number, radius: number, target: Vector3, scene: Scene);
        alpha: number;
        beta: number;
        target: Vector3;
        minZ: number;
        maxZ: number;
        lowerRadiusLimit: number;
        upperRadiusLimit: number;
        lowerBetaLimit: number;
        upperBetaLimit: number;
        wheelDeltaPercentage: number;
        pinchDeltaPercentage: number;
        panningSensibility: number;
        inertia: number;
        attachControl(element: HTMLElement, noPreventDefault?: boolean): void;
    }

    class HemisphericLight
    {
        constructor(name: string, direction: Vector3, scene: Scene);
        intensity: number;
        groundColor: Color3;
    }

    class Scene
    {
        constructor(engine: Engine);
        clearColor: Color4;
        fogMode: number;
        fogColor: Color3;
        fogDensity: number;
        pointerX: number;
        pointerY: number;
        onPointerObservable: { add(callback: (info: PointerInfo) => void): void };
        static FOGMODE_EXP2: number;
        pick(x: number, y: number, predicate?: (mesh: Mesh) => boolean): PickingInfo;
        render(): void;
        getTransformMatrix(): Matrix;
    }

    interface PointerInfo
    {
        type: number;
        event: PointerEvent;
    }

    interface PickingInfo
    {
        hit: boolean;
        pickedMesh: Mesh;
    }

    const PointerEventTypes: {
        POINTERDOWN: number;
        POINTERUP: number;
        POINTERMOVE: number;
        POINTERWHEEL: number;
        POINTERTAP: number;
    };

    class MeshBuilder
    {
        static CreateBox(name: string, options: Record<string, unknown>, scene: Scene): Mesh;
        static CreateGround(name: string, options: Record<string, unknown>, scene: Scene): Mesh;
        static CreateDisc(name: string, options: Record<string, unknown>, scene: Scene): Mesh;
        static CreateTorus(name: string, options: Record<string, unknown>, scene: Scene): Mesh;
        static CreateCylinder(name: string, options: Record<string, unknown>, scene: Scene): Mesh;
        static CreateTube(name: string, options: Record<string, unknown>, scene: Scene): Mesh;
        static CreateRibbon(name: string, options: Record<string, unknown>, scene: Scene): Mesh;
        static CreateLines(name: string, options: Record<string, unknown>, scene: Scene): Mesh;
        static CreateLineSystem(name: string, options: Record<string, unknown>, scene: Scene): Mesh;
    }
}
