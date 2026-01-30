import jenkins.model.*
import javaposse.jobdsl.plugin.GlobalJobDslSecurityConfiguration
import jenkins.model.GlobalConfiguration

// Disable Job DSL script security (auto-approve all scripts)
GlobalConfiguration.all().get(GlobalJobDslSecurityConfiguration.class).useScriptSecurity = false
GlobalConfiguration.all().get(GlobalJobDslSecurityConfiguration.class).save()
