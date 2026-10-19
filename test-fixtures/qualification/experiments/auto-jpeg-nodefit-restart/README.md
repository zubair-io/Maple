# Monotone restart of the exact baked-node fit — #5000

The complete9139fcf000 qualification cleared11of12JPEG failures, retaining all
4original passes. The remainingLeica0017constrained fit stalled in its darkest
band. Restart the same optimization from a separable monotone prior, deriving
its design rows by marginalizing the SAME tetrahedral node weights. No image
resampling pass, per-camera rule, budget change or new apply-time stage is added.
The solver retains the best measured candidate across both initializations.

Leica's physical point now passes: worst band bias0.04982592376884747<0.05.
This is close to the existing limit; no tolerance or rounding changed. All5
existing Hassy Auto2banding/smoothness gates pass with unchanged budgets.
Final complete-fixture and relevant host/GPU validation are still pending in
this checkpoint. Production math is shared by CPU/GPU fitting; NeutralAgX,
output37/fit7 and original inputs remain unchanged. Same draft5003,no merge.
