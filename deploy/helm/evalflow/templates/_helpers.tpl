{{- define "evalflow.postgresName" -}}
{{- printf "%s-postgres" .Release.Name -}}
{{- end -}}

{{- define "evalflow.postgresSelectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: postgres
{{- end -}}

{{- define "evalflow.postgresLabels" -}}
{{ include "evalflow.postgresSelectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{- end -}}
