
## 2024-05-18 - [Optimized parallelization in face-bootstrap.ts]
**Learning:** In MongoDB Node.js driver, retrieving the collection instance multiple times inside a `Promise.all` via asynchronous functions (e.g., `workerConfigCollection()`) adds unnecessary overhead. The memory instructs to obtain the MongoDB collection handle once outside the map/loop to minimize redundant asynchronous lookups for the same collection.
**Action:** Always fetch the collection outside of `.map` loops when performing parallel DB operations in `.api` code, reducing connection overhead and DB lookup redundancies.
