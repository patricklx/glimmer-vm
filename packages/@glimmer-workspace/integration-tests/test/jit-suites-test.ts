import {
  DebuggerSuite,
  EachSuite,
  EmberishComponentTests,
  GlimmerishComponents,
  HasBlockParamsHelperSuite,
  HasBlockSuite,
  InElementSuite,
  jitComponentSuite,
  jitSuite,
  ScopeSuite,
  ShadowingSuite,
  TemplateOnlyComponents,
  WithDynamicVarsSuite,
  YieldSuite,
} from '@glimmer-workspace/integration-tests';

jitComponentSuite(DebuggerSuite);
jitSuite(EachSuite);
jitSuite(InElementSuite);

jitComponentSuite(GlimmerishComponents);
jitComponentSuite(TemplateOnlyComponents);
jitComponentSuite(EmberishComponentTests);
jitComponentSuite(HasBlockSuite);
jitComponentSuite(HasBlockParamsHelperSuite);
jitComponentSuite(ScopeSuite);
jitComponentSuite(ShadowingSuite);
jitComponentSuite(WithDynamicVarsSuite);
jitComponentSuite(YieldSuite);
