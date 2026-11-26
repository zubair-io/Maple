// The Android workflow names a Maven Central mirror here: Gradle fails on Central's 429 instead of falling through (#6029).
pluginManagement {
    repositories {
        google()
        System.getenv("MAPLE_MAVEN_CENTRAL_MIRROR")?.let { maven(it) }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        System.getenv("MAPLE_MAVEN_CENTRAL_MIRROR")?.let { maven(it) }
        mavenCentral()
    }
}

rootProject.name = "Maple"

include(":app")
