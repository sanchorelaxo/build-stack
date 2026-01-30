import jenkins.model.*
import hudson.security.*

def instance = Jenkins.getInstance()

def adminUser = System.getenv('JENKINS_ADMIN_USER') ?: 'admin'
def adminPass = System.getenv('JENKINS_ADMIN_PASS') ?: 'admin'

def realm = new HudsonPrivateSecurityRealm(false)
if (realm.getUser(adminUser) == null) {
  realm.createAccount(adminUser, adminPass)
}
instance.setSecurityRealm(realm)

def strategy = new FullControlOnceLoggedInAuthorizationStrategy()
strategy.setAllowAnonymousRead(true)
instance.setAuthorizationStrategy(strategy)

instance.save()
