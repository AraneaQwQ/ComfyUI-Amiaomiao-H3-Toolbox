"""Experimental channel-offset estimation for a restored H3 video overlap."""

import math

import torch


FRAME_SPANS = (1, 4, 4, 4, 4)
MIN_OFFSET = 0.002
MAX_OFFSET = 0.03
MIN_AGREEMENT = 0.5
MIN_EXPLAINED = 0.02


def estimate_offset(original, redrawn):
    """Estimate each batch independently in units of spatial channel deviation.

    Temporal median suppresses individual outliers. Temporal agreement and the
    residual energy explained by a constant offset control confidence. A channel
    offset is only a latent-space hypothesis about color, not an RGB transform.
    """
    means, variances, energies = [], [], []
    with torch.no_grad():
        for index in range(original.shape[2]):
            a = original[:, :, index].float()
            b = redrawn[:, :, index].float()
            if not bool(torch.isfinite(a).all() & torch.isfinite(b).all()):
                return None, {"status": "nonfinite_overlap"}
            difference = a - b
            means.append(difference.mean(dim=(-2, -1)))
            variances.append(
                (a.var(dim=(-2, -1), correction=0)
                 + b.var(dim=(-2, -1), correction=0)) * 0.5
            )
            energies.append(difference.square().mean(dim=(-2, -1)))

        differences = torch.stack(means, dim=2)
        variance = torch.stack(variances, dim=2).mean(dim=2)
        # A spatially constant channel supplies no reliable correction scale.
        scale = variance.clamp_min(1e-12).sqrt()
        normalized = differences / scale.unsqueeze(2)
        offset = normalized.quantile(0.5, dim=2)
        signal = offset.square().mean(dim=1)
        variation = (normalized - offset.unsqueeze(2)).square().mean(dim=(1, 2))
        agreement = signal / (signal + variation).clamp_min(1e-12)
        residual = (torch.stack(energies, dim=2).mean(dim=2)
                    / scale.square()).mean(dim=1)
        explained = (
            (2 * offset * normalized.mean(dim=2) - offset.square()).mean(dim=1)
            / residual.clamp_min(1e-12)
        ).clamp(0, 1)
        confidence = agreement * explained.sqrt()
        magnitude = signal.sqrt()
        confidence = torch.where(
            (magnitude >= MIN_OFFSET)
            & (agreement >= MIN_AGREEMENT)
            & (explained >= MIN_EXPLAINED),
            confidence, torch.zeros_like(confidence),
        )
        bounded = offset.clamp(-MAX_OFFSET, MAX_OFFSET) * scale
        correction = bounded * confidence.unsqueeze(1)
        if not bool(torch.isfinite(correction).all()):
            return None, {"status": "nonfinite_statistics"}
        report = {
            "status": "eligible" if bool((confidence > 0).any()) else "below_gate",
            "offset_rms": magnitude.tolist(),
            "temporal_agreement": agreement.tolist(),
            "explained_fraction": explained.tolist(),
            "confidence": confidence.tolist(),
            "bounded_channels": (offset.abs() > MAX_OFFSET).sum(dim=1).tolist(),
            "min_offset": MIN_OFFSET,
            "max_offset": MAX_OFFSET,
            "min_agreement": MIN_AGREEMENT,
            "min_explained": MIN_EXPLAINED,
        }
        return correction, report


def compensate_new_content(video, original, redrawn, overlap_steps, strength, fade_frames):
    """Modify a disposable restored tensor only after its exact overlap.

    Each token's interval must fit entirely inside the requested frame window.
    The cosine weight is averaged over the token's represented frame centers.
    A partial token is excluded, so a one-frame fade cannot alter a four-frame
    token or extend the requested window.
    """
    report = {"status": "disabled", "corrected_steps": 0}
    if strength == 0 or fade_frames == 0:
        return report
    correction, report = estimate_offset(original, redrawn)
    report["corrected_steps"] = 0
    if correction is None or report["status"] != "eligible":
        return report
    available_frames = sum(
        FRAME_SPANS[index % len(FRAME_SPANS)]
        for index in range(overlap_steps, video.shape[2])
    )
    effective_frames = min(fade_frames, available_frames)
    elapsed = 0
    weights = []
    for index in range(overlap_steps, video.shape[2]):
        span = FRAME_SPANS[index % len(FRAME_SPANS)]
        if elapsed + span > effective_frames:
            break
        weight = sum(
            0.5 * (1 + math.cos(math.pi * (elapsed + frame + 0.5) / effective_frames))
            for frame in range(span)
        ) / span
        weights.append(weight)
        elapsed += span
    if not weights:
        report["status"] = "window_too_short"
        return report
    target = video[:, :, overlap_steps:overlap_steps + len(weights)]
    if not bool(torch.isfinite(target).all()):
        report["status"] = "nonfinite_new_content"
        return report
    # Convert before the addition and validate before copying, including fp16.
    with torch.no_grad():
        ramp = video.new_tensor(weights, dtype=torch.float32).view(1, 1, -1, 1, 1)
        delta = correction[:, :, None, None, None] * (strength * ramp)
        adjusted = (target + delta).to(dtype=video.dtype)
        if not bool(torch.isfinite(adjusted).all()):
            report["status"] = "nonfinite_result"
            return report
        target.copy_(adjusted)
    report.update(
        status="applied",
        corrected_steps=len(weights),
        covered_frames=elapsed,
        requested_frames=fade_frames,
        effective_fade_frames=effective_frames,
        strength=strength,
        peak_correction_rms=(
            correction.square().mean(dim=1).sqrt() * (strength * weights[0])
        ).tolist(),
        weights=weights,
    )
    return report
