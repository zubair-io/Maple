export type RecipeOp = {
    op: 'autoOrient';
} | {
    op: 'resize';
    width?: number;
    height?: number;
    fit?: string;
    position?: string;
    kernel?: string;
    withoutEnlargement?: boolean;
    withoutReduction?: boolean;
    background?: [number, number, number, number];
} | {
    op: 'flatten';
    background?: [number, number, number, number];
} | {
    op: 'ensureAlpha';
    alpha?: number;
} | {
    op: 'removeAlpha';
} | {
    op: 'composite';
    layers: Array<RecipeLayer>;
} | {
    op: 'extract';
    left: number;
    top: number;
    width: number;
    height: number;
} | {
    op: 'extend';
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    extendWith?: string;
    background?: [number, number, number, number];
} | {
    op: 'rotate';
    angle: number;
    background?: [number, number, number, number];
} | {
    op: 'flip';
} | {
    op: 'flop';
} | {
    op: 'trim';
    background?: [number, number, number, number] | null;
    threshold?: number;
    margin?: number;
    lineArt?: boolean;
} | {
    op: 'greyscale';
} | {
    op: 'gamma';
    exponent: number;
} | {
    op: 'linear';
    a?: [number, number, number];
    b?: [number, number, number];
} | {
    op: 'negate';
    alpha?: boolean;
} | {
    op: 'normalise';
    lower?: number;
    upper?: number;
} | {
    op: 'modulate';
    brightness?: number;
    saturation?: number;
    hue?: number;
    lightness?: number;
} | {
    op: 'tint';
    rgb: [number, number, number];
} | {
    op: 'toColourspace';
    space: string;
} | ({
    op: 'blur';
} & RecipeBlurOp) | ({
    op: 'sharpen';
} & RecipeSharpenOp) | ({
    op: 'median';
} & RecipeMedianOp) | ({
    op: 'threshold';
} & RecipeThresholdOp) | ({
    op: 'convolve';
} & RecipeConvolveOp);
export type RecipeBlurOp = {
    sigma?: number | null;
};
export type RecipeConvolveOp = {
    width: number;
    height: number;
    kernel: Array<number>;
    scale?: number | null;
    offset?: number;
};
export type RecipeLayer = {
    aux: RecipeAuxRef;
    raw?: RecipeRawSpec | null;
    left?: number | null;
    top?: number | null;
    gravity?: string;
    blend?: string;
    tile?: boolean;
};
export type RecipeAuxRef = {
    off: number;
    len: number;
};
export type RecipeMedianOp = {
    size?: number;
};
export type RecipeOutput = {
    format: 'jpeg';
    quality?: number;
    progressive?: boolean;
    chromaSubsampling?: string;
    optimiseCoding?: boolean;
} | {
    format: 'png';
    compressionLevel?: number;
    adaptiveFiltering?: boolean;
    palette?: boolean;
    colours?: number;
    dither?: number;
} | {
    format: 'webp';
    lossless?: boolean;
} | {
    format: 'avif';
    quality?: number;
    effort?: number;
    lossless?: boolean;
    chromaSubsampling?: string;
    bitdepth?: number;
} | {
    format: 'tiff';
    compression?: string;
    bitdepth?: number;
    predictor?: string;
} | {
    format: 'raw';
};
export type RecipeRawSpec = {
    width: number;
    height: number;
    channels: number;
};
export type RecipeSharpenOp = {
    sigma?: number | null;
    m1?: number;
    m2?: number;
    x1?: number;
    y2?: number;
    y3?: number;
};
export type RecipeThresholdOp = {
    value?: number;
    greyscale?: boolean;
};
