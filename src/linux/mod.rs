//! Linux builds currently expose the platform-agnostic decoder helpers.
//!
//! Native application discovery and audio capture are still implemented only
//! for macOS and Windows. Keeping an explicit Linux module makes that support
//! level intentional in the crate graph and gives us a clear place to extend
//! the backend later.

#[cfg(test)]
mod tests {
  #[test]
  fn test_linux_module_loads() {
    assert!(true);
  }
}
