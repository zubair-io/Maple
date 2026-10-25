//! A tick's [`CreativePlan`] as [`raw_gpu::CreativeInputs`] (#5376).
use crate::pipeline::{CreativePlan, PlanTable};

fn table(table: &PlanTable) -> raw_gpu::CreativeTable {
    raw_gpu::CreativeTable {
        dims: table.dims,
        srgb: table.srgb,
        cold_offset: table.cold_offset,
        warm_offset: table.warm_offset,
        warm_weight: table.warm_weight,
    }
}

pub fn creative_inputs<'a>(plan: &CreativePlan<'a>) -> raw_gpu::CreativeInputs<'a> {
    raw_gpu::CreativeInputs {
        to_pro: plan.to_pro.0,
        from_pro: plan.from_pro.0,
        tables: plan.tables,
        hsm: plan.hsm.as_ref().map(table),
        look: plan.look.as_ref().map(table),
        highlight_recovery: plan.highlight_recovery,
        post: plan.post.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::creative::{creative_stage, Tables};
    use crate::xmp::AdjustmentModel;

    #[test]
    fn inputs_borrow_the_wire_and_carry_every_plan_field() {
        let stage = creative_stage(Tables::DualHueSatMapAndLook, 1.8);
        let wire = stage.gpu_wire();
        let model = AdjustmentModel {
            temperature: 3300.0,
            tint: 9.0,
            temperature_seen: true,
            tint_seen: true,
            ..AdjustmentModel::default()
        };
        let plan = stage.gpu_plan(&wire, &model).unwrap();
        let inputs = creative_inputs(&plan);
        assert_eq!(inputs.tables.as_ptr(), plan.tables.as_ptr());
        assert_eq!(inputs.to_pro, plan.to_pro.0);
        assert_eq!(inputs.post, plan.post.0);
        let (hsm, want) = (inputs.hsm.unwrap(), plan.hsm.unwrap());
        assert_eq!(
            (hsm.cold_offset, hsm.warm_offset, hsm.warm_weight),
            (want.cold_offset, want.warm_offset, want.warm_weight)
        );
        assert!(hsm.warm_offset.is_some() && inputs.look.is_some());
    }
}
