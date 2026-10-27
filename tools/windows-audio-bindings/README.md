# Windows audio bindings

Regenerate the private audio COM bindings from the repository root:

```sh
cargo run --locked --manifest-path tools/windows-audio-bindings/Cargo.toml
```

The generator is pinned to the published `windows-bindgen` 0.100.0 release and
uses its bundled Windows metadata. The tool's lockfile fixes its transitive
dependencies too. CI checks that regeneration produces no diff.
Only the audio interfaces, methods, COM functions, and their required signature
types are included. The generated file keeps the original COM vtable layout even
when unused methods are omitted.

The latest published `windows` release is 0.62.2, whose interfaces use
`windows-core` 0.62.2. Our audio callback implementations use the current
`windows-core` 0.100.0, so they need bindings generated for that runtime. This is
the [upstream-supported approach for library bindings](https://github.com/microsoft/windows-rs/blob/master/docs/crates/windows-bindgen.md).
The process APIs and CPAL still use their own `windows` bindings. No COM values,
GUIDs, or errors are passed between the two core versions.

When upgrading, update the generator and regenerate alongside any required audio
API migration. In 0.100, some methods expose `HRESULT` directly (convert it with
`.ok()`), and flags are integers rather than newtypes. The Windows Rust test
exercises callback dispatch, interface casts, and success/error propagation;
cross-compilation alone does not run that test.
