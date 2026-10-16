plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// CI runs the real JNI renderer on an x86_64 KVM emulator and still builds arm64.
val nativeAbis = providers.gradleProperty("mapleAbis").orElse("arm64-v8a").get().split(",")
require(nativeAbis.isNotEmpty() && nativeAbis.all { it in setOf("arm64-v8a", "x86_64") })

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
        ndk { abiFilters += nativeAbis }
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
    testOptions { unitTests.isIncludeAndroidResources = true }
}

abstract class StageTestFixtures : DefaultTask() {
    @get:InputFiles abstract val fixtures: ConfigurableFileCollection
    @get:OutputDirectory abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun stage() {
        val directory = outputDirectory.get().asFile
        directory.deleteRecursively()
        directory.mkdirs()
        fixtures.files.forEach { it.copyTo(directory.resolve(it.name), overwrite = true) }
    }
}

val stageTestFixtures by
    tasks.registering(StageTestFixtures::class) {
        fixtures.from(
            rootProject.file("../../test-fixtures/batch-transfer/source.dng"),
            rootProject.file("../../test-fixtures/android/portrait.dng"),
            rootProject.file("../apple/MapleUITests/Fixtures/layout/rgb-gradient.png"),
            rootProject.file("../../test-fixtures/raster-metadata/avif-validation/srgb-rgb.avif"),
            rootProject.file("../../test-fixtures/android/wide-p3.avif"),
            rootProject.file("../../test-fixtures/android/large-48mp.heic"),
            rootProject.file("../../test-fixtures/raster-metadata/avif-10.avif"),
        )
        outputDirectory.set(layout.buildDirectory.dir("generated/test-fixtures"))
    }

androidComponents.onVariants { variant ->
    variant.deviceTests.values.forEach { test ->
        test.sources.assets?.addGeneratedSourceDirectory(
            stageTestFixtures,
            StageTestFixtures::outputDirectory,
        )
    }
}

val buildRust by
    tasks.registering(Exec::class) {
        workingDir(rootProject.projectDir)
        commandLine(listOf("bash", "scripts/build-native.sh") + nativeAbis)
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
