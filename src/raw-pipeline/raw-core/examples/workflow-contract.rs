//! Strict round-trip endpoint for the #4035 cross-language storage harness.
//! No originals or sidecars are modified; stdin/stdout carry wire records.
use raw_core::workflow::SidecarWorkflow;
use std::io::{self, Read};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let records: Vec<serde_json::Value> = serde_json::from_str(&input)?;
    let values: Result<Vec<_>, _> = records
        .iter()
        .map(|value| SidecarWorkflow::parse(&value.to_string()))
        .collect();
    let values = values.map_err(io::Error::other)?;
    println!("{}", serde_json::to_string(&values)?);
    Ok(())
}
