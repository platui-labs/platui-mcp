pipeline {
    agent {
        node {
            label 'node-18' // Assumes a build agent with Node.js 18+ installed
        }
    }
    environment {
        ENVIRONMENT = 'production'
    }
    stages {
        stage('Install & Verify') {
            steps {
                script {
                    echo 'Installing dependencies...'
                    sh 'npm ci'
                    
                    echo 'Running typescript compiler and verification tests...'
                    sh 'npm run verify'
                }
            }
        }

        stage('Deploy to Production') {
            steps {
                script {
                    echo 'Deploying to Cloudflare Worker Production...'
                    withCredentials([
                        string(credentialsId: 'cloudflare-api-token-production', variable: 'CLOUDFLARE_API_TOKEN'),
                        string(credentialsId: 'cloudflare-account-id-production', variable: 'CLOUDFLARE_ACCOUNT_ID')
                    ]) {
                        sh 'npx wrangler deploy --env production'
                    }
                }
            }
        }
    }
    post {
        always {
            script {
                String blueOceanUrl = 'https://jenkins.platui.com/blue/organizations/jenkins/' +
                        "${JOB_NAME}/detail/${JOB_NAME}/${env.BUILD_NUMBER}"
                notifyDiscord(currentBuild.result, env.version, blueOceanUrl)
            }
        }
    }
}

void notifyDiscord(String buildStatus, String packageVersion, String blueOceanUrl) {
    withCredentials([string(credentialsId: 'discord-test-channel-webhook', variable: 'DISCORD_WEBHOOK_URL')]) {
        String versionMessage = packageVersion ? "\nPackage Version: ${packageVersion}" : ''
        String message = """
            PlatUI MCP Successfully deployed to Cloudflare Worker Production
            ${buildStatus} [#${env.BUILD_NUMBER}](${blueOceanUrl})
            ${versionMessage}
        """
        discordSend(
                description: message,
                footer: 'Time Taken: ' + currentBuild.durationString,
                link: env.BUILD_URL,
                result: buildStatus,
                title: JOB_NAME,
                webhookURL: env.DISCORD_WEBHOOK_URL
        )
    }
}
