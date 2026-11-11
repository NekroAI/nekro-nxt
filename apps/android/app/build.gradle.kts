plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// CI signs development builds with the repository's development key so they install over each other; local builds
// fall back to the machine's debug key. The release key lives only in the protected release environment
// (.github/workflows/android-release.yml). CI also sets the version: Preview builds count up, releases follow the tag.
val devKeystore: String? = System.getenv("NXT_ANDROID_DEV_KEYSTORE")
val releaseKeystore: String? = System.getenv("NXT_ANDROID_RELEASE_KEYSTORE")
val ciVersionName: String? = System.getenv("NXT_ANDROID_VERSION_NAME")
val ciVersionCode: Int? = System.getenv("NXT_ANDROID_VERSION_CODE")?.toInt()

android {
    namespace = "ai.nekro.nxt"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.nekro.nxt"
        minSdk = 29
        targetSdk = 35
        versionCode = ciVersionCode ?: 1
        versionName = ciVersionName ?: "0.1.0"
    }

    signingConfigs {
        if (devKeystore != null) {
            create("dev") {
                storeFile = file(devKeystore)
                storePassword = System.getenv("NXT_ANDROID_DEV_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("NXT_ANDROID_DEV_KEY_ALIAS")
                keyPassword = System.getenv("NXT_ANDROID_DEV_KEY_PASSWORD")
            }
        }
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("NXT_ANDROID_RELEASE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("NXT_ANDROID_RELEASE_KEY_ALIAS")
                keyPassword = System.getenv("NXT_ANDROID_RELEASE_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".dev"
            if (ciVersionName == null) versionNameSuffix = "-dev"
            resValue("string", "app_name", "NekroNXT 开发版")
            // Development builds update from the rolling Preview.
            buildConfigField("String", "UPDATE_CHANNEL", "\"preview\"")
            if (devKeystore != null) signingConfig = signingConfigs.getByName("dev")
        }
        release {
            isMinifyEnabled = false
            resValue("string", "app_name", "NekroNXT")
            buildConfigField("String", "UPDATE_CHANNEL", "\"stable\"")
            if (releaseKeystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.webkit:webkit:1.12.1")
    // QR scanning without Google Play services, which many phones in China do not have.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
