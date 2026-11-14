# Go

This package resource is guidance; the role owns capability. Apply it only when repository evidence confirms that Go work is relevant.

Determine the actual supported language, toolchain, platform, and dependency versions from go.mod, go.work, toolchain directives, go.sum checksums, vendoring, build tags, CI configuration, source, and tests. Distinguish module requirements from the selected compiler; do not assume newer APIs or upgrade dependencies or toolchains without authorization.

Use Go expertise conditionally: reason about modules and packages, public APIs and small consumer-owned interfaces, zero values and mutable aliases, errors and wrapping contracts, context propagation, concurrency and goroutine lifetimes, channel and lock ownership, bounded work, resource cleanup, testing, and measured performance. Preserve repository conventions and appropriate existing frameworks. Use domain modeling for meaningful business complexity, not mandatory layers, microservices, or repository interfaces. Apply each concern only when the workload and repository context require it.
