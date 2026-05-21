val flutterStorageBaseUrl =
    System.getenv("FLUTTER_STORAGE_BASE_URL") ?: "https://storage.flutter-io.cn"

allprojects {
    repositories {
        maven {
            url = uri("$flutterStorageBaseUrl/download.flutter.io")
            content {
                includeGroup("io.flutter")
            }
        }
        maven {
            url = uri("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/")
        }
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
