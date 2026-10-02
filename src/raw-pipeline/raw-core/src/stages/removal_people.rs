//! Conservative, reviewable person-role proposals (#3984 / #1472).
//! Box size suggests prominence, not depth or photographer intent. This
//! experimental policy needs labeled scene qualification before release.
use crate::types::removal_models::REMOVAL_PERSON_MIN_SCORE;
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Detection {
    pub class: u8,
    pub bounds: [f32; 4],
    pub score: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PersonRole {
    Subject,
    Background,
    Uncertain,
}
impl PersonRole {
    pub const ALL: [Self; 3] = [Self::Subject, Self::Background, Self::Uncertain];
    pub fn name(self) -> &'static str {
        match self {
            Self::Subject => "subject",
            Self::Background => "background",
            Self::Uncertain => "uncertain",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Subject => "Likely subject",
            Self::Background => "Suggested background",
            Self::Uncertain => "Uncertain",
        }
    }
}

#[derive(Serialize)]
pub struct PersonSuggestion {
    pub detection: Detection,
    pub role: PersonRole,
    pub keep: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema: u32,
    source_width: u32,
    source_height: u32,
    detections: Vec<Detection>,
}

/// Fixed policy shared by C and WASM. No host thresholds or slider work.
/// Subjects and uncertain instances default to Keep; only confident, much
/// smaller, non-overlapping people are suggested for removal. Every default
/// is user-overridable and cannot authorize a durable edit.
pub fn suggest_json(request: &str) -> Result<String, String> {
    let request: Request = serde_json::from_str(request)
        .map_err(|e| format!("person suggestions: invalid request: {e}"))?;
    if request.schema != 1
        || request.source_width == 0
        || request.source_height == 0
        || request.detections.len() > 300
    {
        return Err("person suggestions: invalid schema, source or proposal count".into());
    }
    let (w, h) = (request.source_width as f32, request.source_height as f32);
    let mut detections = Vec::new();
    for d in request.detections {
        if d.class >= 80
            || !d.score.is_finite()
            || !(0.0..=1.0).contains(&d.score)
            || d.bounds.iter().any(|v| !v.is_finite())
        {
            return Err("person suggestions: invalid detector output".into());
        }
        if d.class != 0 || d.score < REMOVAL_PERSON_MIN_SCORE {
            continue;
        }
        let bounds = [
            d.bounds[0].clamp(0.0, w),
            d.bounds[1].clamp(0.0, h),
            d.bounds[2].clamp(0.0, w),
            d.bounds[3].clamp(0.0, h),
        ];
        if bounds[2] <= bounds[0] || bounds[3] <= bounds[1] {
            continue;
        }
        detections.push(Detection { bounds, ..d });
    }
    // Stable source coordinates break confidence ties consistently on hosts.
    detections.sort_by(|a, b| {
        b.score.total_cmp(&a.score).then_with(|| {
            a.bounds
                .iter()
                .zip(b.bounds)
                .find_map(|(a, b)| {
                    let order = a.total_cmp(&b);
                    (order != std::cmp::Ordering::Equal).then_some(order)
                })
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    let mut unique: Vec<Detection> = Vec::new();
    for d in detections {
        if !unique.iter().any(|other| iou(&d, other) >= 0.85) {
            unique.push(d);
        }
    }
    let largest = unique
        .iter()
        .filter(|d| d.score >= 0.8)
        .max_by(|a, b| area(a).total_cmp(&area(b)));
    let mut roles = unique
        .iter()
        .map(|d| {
            let Some(largest) = largest else {
                return PersonRole::Uncertain;
            };
            if d.score < 0.8 {
                return PersonRole::Uncertain;
            }
            let area_ratio = area(d) / area(largest);
            let height_ratio = height(d) / height(largest);
            if area_ratio >= 0.5 || height_ratio >= 0.7 {
                PersonRole::Subject
            } else if area_ratio <= 0.25 && height_ratio <= 0.5 {
                PersonRole::Background
            } else {
                PersonRole::Uncertain
            }
        })
        .collect::<Vec<_>>();
    // Propagate uncertainty across overlapping boxes until no suggested
    // background instance touches a kept instance, including newly kept ones.
    loop {
        let touching = unique
            .iter()
            .enumerate()
            .filter_map(|(index, d)| {
                (roles[index] == PersonRole::Background
                    && unique.iter().zip(&roles).any(|(other, role)| {
                        *role != PersonRole::Background && intersection(d, other) > 0.0
                    }))
                .then_some(index)
            })
            .collect::<Vec<_>>();
        if touching.is_empty() {
            break;
        }
        for index in touching {
            roles[index] = PersonRole::Uncertain;
        }
    }
    let suggestions = unique
        .into_iter()
        .zip(roles)
        .map(|(detection, role)| PersonSuggestion {
            detection,
            role,
            keep: role != PersonRole::Background,
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&suggestions).map_err(|e| e.to_string())
}

fn height(d: &Detection) -> f32 {
    d.bounds[3] - d.bounds[1]
}
fn area(d: &Detection) -> f32 {
    (d.bounds[2] - d.bounds[0]) * height(d)
}
fn intersection(a: &Detection, b: &Detection) -> f32 {
    (a.bounds[2].min(b.bounds[2]) - a.bounds[0].max(b.bounds[0])).max(0.0)
        * (a.bounds[3].min(b.bounds[3]) - a.bounds[1].max(b.bounds[1])).max(0.0)
}
fn iou(a: &Detection, b: &Detection) -> f32 {
    let common = intersection(a, b);
    common / (area(a) + area(b) - common)
}

#[cfg(test)]
#[path = "removal_people_tests.rs"]
mod tests;
