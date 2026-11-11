// The smallest package for the drift demo: published once, then upgraded once by changing this body,
// so the original package id becomes a stale version 1 (see scripts/demo/move/README.md).
module buiry_demo::demo;

/// Returns the package revision. The upgrade changes 1 to 2.
public fun revision(): u64 {
    2
}
