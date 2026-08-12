export type VideoColorSpaceMetadata = Readonly<{
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
}>;

export type PortableVideoColorConversionPlan = Readonly<{
  sourceKind: "hdr-pq" | "hdr-hlg" | "hdr-other" | "wide-gamut-sdr" | "sdr" | "unknown";
  isHighDynamicRange: boolean;
  isWideGamut: boolean;
  requiresToneMapping: boolean;
  outputCanvasColorSpace: "srgb";
  outputKind: "rec709-compatible-sdr";
}>;

/**
 * Classifies WebCodecs/Mediabunny color metadata without relying on a codec
 * name. The portable exporter always renders into an sRGB canvas, which asks
 * the browser to perform its color-managed SDR conversion before H.264 encode.
 */
export function createPortableVideoColorConversionPlan({
  colorSpace = {},
  hasHighDynamicRange = false,
}: {
  colorSpace?: VideoColorSpaceMetadata;
  hasHighDynamicRange?: boolean;
} = {}): PortableVideoColorConversionPlan {
  const primaries = colorSpace.primaries?.toLowerCase() ?? null;
  const transfer = colorSpace.transfer?.toLowerCase() ?? null;
  const pq = transfer === "pq";
  const hlg = transfer === "hlg";
  const isHighDynamicRange = Boolean(hasHighDynamicRange || pq || hlg);
  const isWideGamut =
    primaries === "bt2020" ||
    primaries === "smpte432" ||
    primaries === "display-p3";
  const knownSdr =
    !isHighDynamicRange &&
    ["bt709", "bt470bg", "smpte170m"].includes(primaries ?? "") &&
    transfer !== null;
  const sourceKind = pq
    ? "hdr-pq"
    : hlg
      ? "hdr-hlg"
      : isHighDynamicRange
        ? "hdr-other"
        : isWideGamut
          ? "wide-gamut-sdr"
          : knownSdr
            ? "sdr"
            : "unknown";

  return {
    sourceKind,
    isHighDynamicRange,
    isWideGamut,
    requiresToneMapping: isHighDynamicRange,
    outputCanvasColorSpace: "srgb",
    outputKind: "rec709-compatible-sdr",
  };
}
