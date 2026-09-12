# Console tool inspection

The private Console now has independently expandable source/argument and result views, copy and line-wrap controls, and richer command output previews. Action summaries cover more capability groups, filesystem writes remain visible alongside command receipts, and non-run tools and results outside loaded call history remain inspectable. Short edits support before/after views.

Source-derived cards are marked as source previews, not execution confirmations. Command output stays attached to its own invocation; runtime truncation is shown explicitly. Tool output remains literal text and never becomes speech. No configuration, transcript migration, or capability changes are required.

Validation: focused Console regressions, production build, and Playwright CLI browser acceptance against the built server with synthetic history, including keyboard and mobile checks passed. The deterministic suite had one failure in the existing fixed-delay run/wake test; all ten tests in that file passed on isolated rerun.

After updating, reload the Console to load the new client assets. No resident work needs to be resumed for this change.
