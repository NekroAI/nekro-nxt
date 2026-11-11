plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// CI signs development builds with the repository's development key so they install over each other; local builds
// fall back to the machine's debug key. The release key lives only in the protected release environment.
val devKeystore: String? = System.getenv("NXT_ANDROID_DEV_KEYSTORE")

android {
    namespace = "ai.nekro.nxt"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.nekro.nxt"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
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
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            resValue("string", "app_name", "NekroNXT 开发版")
            if (devKeystore != null) signingConfig = signingConfigs.getByName("dev")
        }
        release {
            isMinifyEnabled = false
            resValue("string", "app_name", "NekroNXT")
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
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
