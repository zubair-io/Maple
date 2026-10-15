plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "app.justmaple.aperture"
    compileSdk = 36
    ndkVersion = "28.2.13676358"
    defaultConfig {
        applicationId = "app.justmaple.aperture"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += "arm64-v8a" }
        externalNativeBuild { cmake { arguments += "-DANDROID_STL=c++_shared" } }
    }
    buildFeatures { compose = true }
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging { jniLibs.useLegacyPackaging = false }
    sourceSets
        .getByName("androidTest")
        .assets
        .srcDir(rootProject.file("../../test-fixtures/batch-transfer"))
    testOptions { unitTests.isIncludeAndroidResources = true }
}

val buildRust by
    tasks.registering(Exec::class) {
        workingDir(rootProject.projectDir)
        commandLine("bash", "scripts/build-native.sh")
        // Cargo owns dependency/resource freshness; always let it inspect its graph.
    }

tasks.configureEach {
    if (name.startsWith("configureCMake") || name.startsWith("buildCMake")) dependsOn(buildRust)
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.01.00"))
    implementation("androidx.activity:activity-compose:1.12.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.documentfile:documentfile:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.01.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test:runner:1.7.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
